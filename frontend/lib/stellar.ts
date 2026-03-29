/**
 * lib/stellar.ts
 * Stellar blockchain helpers for MarketPay.
 */

import {
  Horizon,
  Networks,
  Asset,
  Operation,
  TransactionBuilder,
  Transaction,
  Contract,
  Address,
  nativeToScVal,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { Server as SorobanServer, Api } from "@stellar/stellar-sdk/rpc";

const NETWORK = (process.env.NEXT_PUBLIC_STELLAR_NETWORK || "testnet") as "testnet" | "mainnet";
const HORIZON_URL = process.env.NEXT_PUBLIC_HORIZON_URL || "https://horizon-testnet.stellar.org";

/** Soroban RPC (Stellar RPC) — used for smart contract calls. */
const SOROBAN_RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ||
  (NETWORK === "mainnet"
    ? "https://soroban-mainnet.stellar.org"
    : "https://soroban-testnet.stellar.org");

export const NETWORK_PASSPHRASE = NETWORK === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
export const server = new Horizon.Server(HORIZON_URL);

/** Shared Soroban RPC client for simulate / prepare / submit / poll. */
export const sorobanServer = new SorobanServer(SOROBAN_RPC_URL, { allowHttp: SOROBAN_RPC_URL.startsWith("http://") });

// USDC asset issued by Circle
export const USDC_ISSUER =
  NETWORK === "mainnet"
    ? "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
    : "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
export const USDC = new Asset("USDC", USDC_ISSUER);

// ─── Account ─────────────────────────────────────────────────────────────────

export async function getXLMBalance(publicKey: string): Promise<string> {
  try {
    const account = await server.loadAccount(publicKey);
    const xlm = account.balances.find((b) => b.asset_type === "native");
    return xlm ? xlm.balance : "0";
  } catch {
    throw new Error("Account not found or not funded.");
  }
}

export async function getUSDCBalance(publicKey: string): Promise<string | null> {
  try {
    const account = await server.loadAccount(publicKey);
    const usdc = account.balances.find(
      (b): b is Horizon.HorizonApi.BalanceLineAsset =>
        b.asset_type !== "native" &&
        (b as Horizon.HorizonApi.BalanceLineAsset).asset_code === "USDC" &&
        (b as Horizon.HorizonApi.BalanceLineAsset).asset_issuer === USDC_ISSUER
    );
    return usdc ? usdc.balance : null;
  } catch {
    return null;
  }
}

// ─── Payments ─────────────────────────────────────────────────────────────────

/**
 * Build an unsigned payment transaction for XLM or USDC.
 */
export async function buildPaymentTransaction({
  fromPublicKey, toPublicKey, amount, memo, asset = "XLM",
}: {
  fromPublicKey: string;
  toPublicKey: string;
  amount: string;
  memo?: string;
  asset?: "XLM" | "USDC";
}) {
  const sourceAccount = await server.loadAccount(fromPublicKey);

  // Check recipient trustline for USDC
  if (asset === "USDC") {
    const recipient = await server.loadAccount(toPublicKey).catch(() => null);
    if (!recipient) throw new Error("Recipient account not found on Stellar network.");
    const hasTrustline = recipient.balances.some(
      (b): b is Horizon.HorizonApi.BalanceLineAsset =>
        b.asset_type !== "native" &&
        (b as Horizon.HorizonApi.BalanceLineAsset).asset_code === "USDC" &&
        (b as Horizon.HorizonApi.BalanceLineAsset).asset_issuer === USDC_ISSUER
    );
    if (!hasTrustline) {
      throw new Error("Recipient has no USDC trustline. They must add USDC to their wallet first.");
    }
  }

  const builder = new TransactionBuilder(sourceAccount, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.payment({
      destination: toPublicKey,
      asset: asset === "USDC" ? USDC : Asset.native(),
      amount,
    }))
    .setTimeout(60);

  if (memo) {
    const { Memo } = await import("@stellar/stellar-sdk");
    builder.addMemo(Memo.text(memo.slice(0, 28)));
  }

  return builder.build();
}

export async function submitTransaction(signedXDR: string) {
  const tx = new Transaction(signedXDR, NETWORK_PASSPHRASE);
  try {
    return await server.submitTransaction(tx);
  } catch (err: unknown) {
    const e = err as { response?: { data?: { extras?: { result_codes?: unknown } } } };
    if (e?.response?.data?.extras?.result_codes) {
      throw new Error(`Transaction failed: ${JSON.stringify(e.response.data.extras.result_codes)}`);
    }
    throw err;
  }
}

// ─── Soroban escrow (release_escrow) ───────────────────────────────────────────

const CONTRACT_ID_RE = /^C[A-Z0-9]{55}$/;

function friendlySorobanError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  if (lower.includes("insufficient") && (lower.includes("balance") || lower.includes("fund"))) {
    return "Not enough XLM to pay the network fee. Add a small amount of test XLM to this account and try again.";
  }
  if (lower.includes("simulation") && lower.includes("failed")) {
    return "The contract rejected this transaction (simulation failed). Check that the job ID matches the on-chain escrow and that you are the client.";
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return "The network took too long to confirm. Check Stellar Expert for the transaction status.";
  }
  if (raw.length > 220) return `${raw.slice(0, 220)}…`;
  return raw;
}

/**
 * Builds a prepared Soroban transaction that invokes `release_escrow(job_id, client)` on the escrow contract.
 * Sign the returned transaction with Freighter, then call {@link submitSignedSorobanTransaction}.
 */
export async function buildReleaseEscrowTransaction(
  contractId: string,
  jobId: string,
  clientAddress: string
): Promise<Transaction> {
  if (!CONTRACT_ID_RE.test(contractId)) {
    throw new Error("Invalid escrow contract ID. Expected a Soroban contract address (C…).");
  }
  if (!jobId.trim()) throw new Error("Job ID is required.");
  if (!/^G[A-Z0-9]{55}$/.test(clientAddress)) {
    throw new Error("Invalid client account.");
  }

  try {
    const account = await sorobanServer.getAccount(clientAddress);
    const contract = new Contract(contractId);
    const op = contract.call(
      "release_escrow",
      nativeToScVal(jobId),
      Address.fromString(clientAddress).toScVal()
    );

    const built = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(op)
      .setTimeout(60)
      .build();

    return await sorobanServer.prepareTransaction(built);
  } catch (err: unknown) {
    throw new Error(friendlySorobanError(err));
  }
}

/**
 * Submits a signed Soroban transaction via RPC and polls until success or failure.
 * @returns Confirmed transaction hash (ledger close).
 */
export async function submitSignedSorobanTransaction(signedXdr: string): Promise<{ hash: string }> {
  let tx: Transaction;
  try {
    tx = new Transaction(signedXdr, NETWORK_PASSPHRASE);
  } catch (err: unknown) {
    throw new Error(friendlySorobanError(err));
  }

  let sent: Api.SendTransactionResponse;
  try {
    sent = await sorobanServer.sendTransaction(tx);
  } catch (err: unknown) {
    throw new Error(friendlySorobanError(err));
  }

  if (sent.status === "ERROR") {
    const detail =
      sent.errorResult != null
        ? `Transaction rejected: ${String(sent.errorResult)}`
        : "Transaction was rejected by the network.";
    throw new Error(friendlySorobanError(new Error(detail)));
  }
  if (sent.status === "TRY_AGAIN_LATER") {
    throw new Error("The network is busy. Wait a few seconds and try again.");
  }

  const hash = sent.hash;
  const maxAttempts = 90;
  for (let i = 0; i < maxAttempts; i += 1) {
    const info = await sorobanServer.getTransaction(hash);
    if (info.status === Api.GetTransactionStatus.SUCCESS) {
      return { hash };
    }
    if (info.status === Api.GetTransactionStatus.FAILED) {
      throw new Error(
        "The on-chain transaction failed. Open the explorer link to see details, or verify the escrow state matches this job."
      );
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    "Confirmation timed out waiting for the network. Your transaction may still succeed — check Stellar Expert using the hash from your wallet."
  );
}

// ─── Utilities ────────────────────────────────────────────────────────────────

export function isValidStellarAddress(address: string): boolean {
  return /^G[A-Z0-9]{55}$/.test(address);
}

export function explorerUrl(hash: string): string {
  const net = NETWORK === "mainnet" ? "public" : "testnet";
  return `https://stellar.expert/explorer/${net}/tx/${hash}`;
}

export function accountUrl(address: string): string {
  const net = NETWORK === "mainnet" ? "public" : "testnet";
  return `https://stellar.expert/explorer/${net}/account/${address}`;
}

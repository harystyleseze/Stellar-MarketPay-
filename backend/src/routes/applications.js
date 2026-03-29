/**
 * src/routes/applications.js
 */
"use strict";
const express = require("express");
const router  = express.Router();
const { createRateLimiter } = require("../middleware/rateLimiter");

const applicationRateLimiter = createRateLimiter(5, 1); // 100 requests per 15 minutes
const generalApplicationRateLimiter = createRateLimiter(30, 1); // 100 requests per minute for listing/getting applications

const {
  submitApplication, getApplicationsForJob,
  getApplicationsForFreelancer, acceptApplication,
} = require("../services/applicationService");

// GET /api/applications/job/:jobId
router.get("/job/:jobId", generalApplicationRateLimiter ,(req, res, next) => {
  try { res.json({ success: true, data: getApplicationsForJob(req.params.jobId) }); }
  catch (e) { next(e); }
});

// GET /api/applications/freelancer/:publicKey
router.get("/freelancer/:publicKey", generalApplicationRateLimiter ,(req, res, next) => {
  try { res.json({ success: true, data: getApplicationsForFreelancer(req.params.publicKey) }); }
  catch (e) { next(e); }
});

// POST /api/applications — submit a proposal
router.post("/", applicationRateLimiter ,(req, res, next) => {
  try {
    const app = submitApplication(req.body);
    res.status(201).json({ success: true, data: app });
  } catch (e) { next(e); }
});

// POST /api/applications/:id/accept — client accepts a proposal
router.post("/:id/accept", applicationRateLimiter ,(req, res, next) => {
  try {
    const app = acceptApplication(req.params.id, req.body.clientAddress);
    res.json({ success: true, data: app });
  } catch (e) { next(e); }
});

module.exports = router;

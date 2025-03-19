// routes/compliance.js
const express = require('express');
const complianceController = require('../controllers/complianceController');

const router = express.Router();

router.post('/check-shipment-compliance', complianceController.checkShipmentCompliance);

module.exports = router;
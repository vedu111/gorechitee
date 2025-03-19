// routes/usa.js
const express = require('express');
const usaController = require('../controllers/usaController');

const router = express.Router();

router.post('/api/find-by-description', usaController.findByDescription);

module.exports = router;
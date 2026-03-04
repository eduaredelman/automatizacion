const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const {
  getCampaigns, createCampaign, getCampaignDetail, cancelCampaign,
} = require('../controllers/campaigns.controller');

router.use(authenticate);

router.get('/',         getCampaigns);
router.post('/',        createCampaign);
router.get('/:id',      getCampaignDetail);
router.post('/:id/cancel', cancelCampaign);

module.exports = router;

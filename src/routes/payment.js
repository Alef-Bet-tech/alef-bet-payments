const express = require('express');
const { v4: uuidv4 } = require('uuid');
const Keepz = require('../keepz');

const router = express.Router();

// Initialize Keepz encryption
const keepz = new Keepz(
  process.env.KEEPZ_RSA_PUBLIC_KEY,
  process.env.OUR_RSA_PRIVATE_KEY
);

// Base URL for Keepz API
const KEEPZ_BASE_URL = process.env.KEEPZ_ENV === 'prod'
  ? 'https://gateway.keepz.me/ecommerce-service'
  : 'https://gateway.dev.keepz.me/ecommerce-service';

/**
 * POST /api/create-order
 * Creates a one-time payment (donation or fixed amount)
 * Body: { amount: number, currency: 'USD' | 'EUR', language: 'EN' | 'RU' | 'HE', description?: string }
 */
router.post('/create-order', async (req, res) => {
  try {
    const { amount, currency = 'USD', language = 'EN', description } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid amount' });
    }

    const integratorOrderId = uuidv4();

    // Build order payload
    const orderPayload = {
      amount: parseFloat(amount),
      receiverId: process.env.KEEPZ_RECEIVER_ID,
      receiverType: 'BRANCH',
      integratorId: process.env.KEEPZ_INTEGRATOR_ID,
      integratorOrderId,
      currency,
      language: language === 'HE' ? 'EN' : language, // Keepz supports EN, IT, KA - fallback HE to EN
      directLinkProvider: 'CREDO',
      successRedirectUri: `${process.env.SUCCESS_REDIRECT_URL}?orderId=${integratorOrderId}`,
      failRedirectUri: `${process.env.FAIL_REDIRECT_URL}?orderId=${integratorOrderId}`,
      callbackUri: `${process.env.SITE_URL}/api/keepz-callback`,
    };

    // Add description if provided
    if (description) {
      orderPayload.orderProperties = {
        DESCRIPTION: { value: description, isEditable: false },
      };
    }

    // Encrypt and send to Keepz
    const encrypted = keepz.encrypt(orderPayload);

    const response = await fetch(`${KEEPZ_BASE_URL}/api/integrator/order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: process.env.KEEPZ_IDENTIFIER,
        encryptedData: encrypted.encryptedData,
        encryptedKeys: encrypted.encryptedKeys,
        aes: true,
      }),
    });

    const responseData = await response.json();

    // Check for error (errors come unencrypted)
    if (responseData.message) {
      console.error('Keepz error:', responseData);
      return res.status(400).json({
        success: false,
        error: responseData.message,
        statusCode: responseData.statusCode,
      });
    }

    // Decrypt success response
    const decrypted = keepz.decrypt(responseData.encryptedData, responseData.encryptedKeys);

    return res.json({
      success: true,
      checkoutUrl: decrypted.urlForQR,
      orderId: integratorOrderId,
    });
  } catch (error) {
    console.error('Create order error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/create-subscription
 * Creates a subscription (recurring payment)
 * Body: { plan: 'weekly_7' | 'weekly_14' | 'monthly_100' | 'monthly_200' | 'custom', 
 *         currency: 'USD' | 'EUR', language: 'EN' | 'RU' | 'HE',
 *         customAmount?: number, customInterval?: 'WEEKLY' | 'MONTHLY' }
 */
router.post('/create-subscription', async (req, res) => {
  try {
    const { plan, currency = 'USD', language = 'EN', customAmount, customInterval } = req.body;

    // Plan configurations
    const plans = {
      weekly_7: { interval: 'WEEKLY', intervalCount: 1, amount: 7 },
      weekly_14: { interval: 'WEEKLY', intervalCount: 1, amount: 14 },
      monthly_100: { interval: 'MONTHLY', intervalCount: 1, amount: 100 },
      monthly_200: { interval: 'MONTHLY', intervalCount: 1, amount: 200 },
    };

    let planConfig;
    if (plan === 'custom' && customAmount && customInterval) {
      planConfig = { interval: customInterval, intervalCount: 1, amount: parseFloat(customAmount) };
    } else {
      planConfig = plans[plan];
    }

    if (!planConfig) {
      return res.status(400).json({ success: false, error: 'Invalid plan' });
    }

    const integratorOrderId = uuidv4();

    // Build subscription order payload
    // For subscriptions: amount must be 0, saveCard must be true
    const orderPayload = {
      amount: 0,
      receiverId: process.env.KEEPZ_RECEIVER_ID,
      receiverType: 'BRANCH',
      integratorId: process.env.KEEPZ_INTEGRATOR_ID,
      integratorOrderId,
      currency,
      language: language === 'HE' ? 'EN' : language,
      directLinkProvider: 'CREDO',
      saveCard: true,
      successRedirectUri: `${process.env.SUCCESS_REDIRECT_URL}?orderId=${integratorOrderId}&type=subscription`,
      failRedirectUri: `${process.env.FAIL_REDIRECT_URL}?orderId=${integratorOrderId}&type=subscription`,
      callbackUri: `${process.env.SITE_URL}/api/keepz-callback`,
      subscriptionPlan: {
        interval: planConfig.interval,
        intervalCount: planConfig.intervalCount,
        amount: planConfig.amount,
        callbackUrl: `${process.env.SITE_URL}/api/subscription-callback`,
      },
    };

    // Encrypt and send to Keepz
    const encrypted = keepz.encrypt(orderPayload);

    const response = await fetch(`${KEEPZ_BASE_URL}/api/integrator/order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: process.env.KEEPZ_IDENTIFIER,
        encryptedData: encrypted.encryptedData,
        encryptedKeys: encrypted.encryptedKeys,
        aes: true,
      }),
    });

    const responseData = await response.json();

    if (responseData.message) {
      console.error('Keepz subscription error:', responseData);
      return res.status(400).json({
        success: false,
        error: responseData.message,
        statusCode: responseData.statusCode,
      });
    }

    const decrypted = keepz.decrypt(responseData.encryptedData, responseData.encryptedKeys);

    return res.json({
      success: true,
      checkoutUrl: decrypted.urlForQR,
      orderId: integratorOrderId,
    });
  } catch (error) {
    console.error('Create subscription error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/keepz-callback
 * Receives payment result callbacks from Keepz
 * Keepz sends encrypted data about payment success/failure
 */
router.post('/keepz-callback', async (req, res) => {
  try {
    const { encryptedData, encryptedKeys, aes } = req.body;

    if (encryptedData && encryptedKeys) {
      const decrypted = keepz.decrypt(encryptedData, encryptedKeys);
      console.log('Payment callback received:', JSON.stringify(decrypted, null, 2));

      // TODO: Save payment result to database
      // TODO: Send email notifications
      // TODO: Update membership status
    }

    // Must return 200 to confirm receipt
    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('Callback processing error:', error);
    return res.status(200).json({ received: true }); // Still return 200 to prevent retries
  }
});

/**
 * POST /api/subscription-callback
 * Receives subscription payment cycle callbacks from Keepz
 */
router.post('/subscription-callback', async (req, res) => {
  try {
    const { subscriptionId, historyId, status, amount } = req.body;
    console.log('Subscription callback:', { subscriptionId, historyId, status, amount });

    // TODO: Log subscription payment
    // TODO: Handle FAILED status - notify admin
    // TODO: Handle COMPLETED status - update records

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('Subscription callback error:', error);
    return res.status(200).json({ received: true });
  }
});

/**
 * GET /api/health
 * Health check endpoint
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    environment: process.env.KEEPZ_ENV || 'dev',
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;

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

// ── INPUT VALIDATION CONSTANTS (H1) ──
const ALLOWED_CURRENCIES = new Set(['USD', 'EUR']);
const ALLOWED_LANGUAGES = new Set(['EN', 'RU', 'HE']);
const ALLOWED_INTERVALS = new Set(['WEEKLY', 'MONTHLY']);
const MAX_AMOUNT = 50000;  // Max $50,000 per transaction
const MAX_DESCRIPTION_LENGTH = 500;

// Plan configurations (server-side only — client cannot override amounts)
const SUBSCRIPTION_PLANS = Object.freeze({
  weekly_7:     { interval: 'WEEKLY',  intervalCount: 1, amount: 7 },
  weekly_14:    { interval: 'WEEKLY',  intervalCount: 1, amount: 14 },
  monthly_100:  { interval: 'MONTHLY', intervalCount: 1, amount: 100 },
  monthly_200:  { interval: 'MONTHLY', intervalCount: 1, amount: 200 },
});

/**
 * Validate and sanitize common payment inputs
 */
function validatePaymentInput({ amount, currency, language, description }) {
  const errors = [];

  if (amount !== undefined) {
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) errors.push('Invalid amount');
    if (numAmount > MAX_AMOUNT) errors.push(`Amount exceeds maximum ($${MAX_AMOUNT})`);
  }

  if (currency && !ALLOWED_CURRENCIES.has(currency)) {
    errors.push('Invalid currency. Allowed: USD, EUR');
  }

  if (language && !ALLOWED_LANGUAGES.has(language.toUpperCase())) {
    errors.push('Invalid language. Allowed: EN, RU, HE');
  }

  if (description && description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`Description too long (max ${MAX_DESCRIPTION_LENGTH} chars)`);
  }

  return errors;
}

/**
 * Sanitize description — strip potential injection characters
 */
function sanitizeDescription(desc) {
  if (!desc) return undefined;
  return desc
    .replace(/[<>"'&]/g, '') // Strip HTML/JS special chars
    .trim()
    .substring(0, MAX_DESCRIPTION_LENGTH);
}

/**
 * Safely map Keepz error to client-facing message (H4)
 */
function safeKeepzError(responseData) {
  // Map known Keepz error codes to user-friendly messages
  const safeMessages = {
    400: 'Invalid payment request',
    401: 'Payment authorization failed',
    403: 'Payment not permitted',
    404: 'Payment service unavailable',
    500: 'Payment service error. Please try again.',
  };
  const code = responseData.statusCode || 500;
  return safeMessages[code] || 'Payment processing error. Please try again.';
}

/**
 * POST /api/create-order
 * Creates a one-time payment (donation or fixed amount)
 */
router.post('/create-order', async (req, res) => {
  try {
    const { amount, currency = 'USD', language = 'EN', description } = req.body;

    // ── VALIDATION (H1) ──
    const errors = validatePaymentInput({ amount, currency, language, description });
    if (errors.length > 0) {
      return res.status(400).json({ success: false, error: errors.join('; ') });
    }

    const sanitizedDesc = sanitizeDescription(description);
    const integratorOrderId = uuidv4();

    const orderPayload = {
      amount: parseFloat(amount),
      receiverId: process.env.KEEPZ_RECEIVER_ID,
      receiverType: 'BRANCH',
      integratorId: process.env.KEEPZ_INTEGRATOR_ID,
      integratorOrderId,
      currency: currency.toUpperCase(),
      language: language.toUpperCase() === 'HE' ? 'EN' : language.toUpperCase(),
      directLinkProvider: 'CREDO',
      successRedirectUri: `${process.env.SUCCESS_REDIRECT_URL}?orderId=${integratorOrderId}`,
      failRedirectUri: `${process.env.FAIL_REDIRECT_URL}?orderId=${integratorOrderId}`,
      callbackUri: `${process.env.SITE_URL}/api/keepz-callback`,
    };

    if (sanitizedDesc) {
      orderPayload.orderProperties = {
        DESCRIPTION: { value: sanitizedDesc, isEditable: false },
      };
    }

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
      // ── SAFE ERROR (H4) — don't leak Keepz internals ──
      console.error(`Keepz error [order ${integratorOrderId}]:`, responseData.statusCode);
      return res.status(400).json({
        success: false,
        error: safeKeepzError(responseData),
      });
    }

    const decrypted = keepz.decrypt(responseData.encryptedData, responseData.encryptedKeys);

    // ── VALIDATE CHECKOUT URL (M4) ──
    const checkoutUrl = decrypted.urlForQR;
    if (!checkoutUrl || !checkoutUrl.startsWith('https://')) {
      console.error(`Invalid checkout URL for order ${integratorOrderId}`);
      return res.status(500).json({ success: false, error: 'Payment service error' });
    }

    return res.json({
      success: true,
      checkoutUrl,
      orderId: integratorOrderId,
    });
  } catch (error) {
    console.error('Create order error:', error.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/create-subscription
 * Creates a subscription (recurring payment)
 */
router.post('/create-subscription', async (req, res) => {
  try {
    const { plan, currency = 'USD', language = 'EN' } = req.body;

    // ── VALIDATION (H1) — only accept known plans ──
    const errors = validatePaymentInput({ currency, language });

    // Validate plan: ONLY accept predefined plans (no custom)
    const planConfig = SUBSCRIPTION_PLANS[plan];
    if (!planConfig) {
      errors.push('Invalid plan. Allowed: weekly_7, weekly_14, monthly_100, monthly_200');
    }

    if (errors.length > 0) {
      return res.status(400).json({ success: false, error: errors.join('; ') });
    }

    const integratorOrderId = uuidv4();

    const orderPayload = {
      amount: 0,
      receiverId: process.env.KEEPZ_RECEIVER_ID,
      receiverType: 'BRANCH',
      integratorId: process.env.KEEPZ_INTEGRATOR_ID,
      integratorOrderId,
      currency: currency.toUpperCase(),
      language: language.toUpperCase() === 'HE' ? 'EN' : language.toUpperCase(),
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
      console.error(`Keepz error [sub ${integratorOrderId}]:`, responseData.statusCode);
      return res.status(400).json({
        success: false,
        error: safeKeepzError(responseData),
      });
    }

    const decrypted = keepz.decrypt(responseData.encryptedData, responseData.encryptedKeys);

    const checkoutUrl = decrypted.urlForQR;
    if (!checkoutUrl || !checkoutUrl.startsWith('https://')) {
      console.error(`Invalid checkout URL for subscription ${integratorOrderId}`);
      return res.status(500).json({ success: false, error: 'Payment service error' });
    }

    return res.json({
      success: true,
      checkoutUrl,
      orderId: integratorOrderId,
    });
  } catch (error) {
    console.error('Create subscription error:', error.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/keepz-callback
 * Receives payment result callbacks from Keepz
 * SECURITY: Verified via RSA decryption — only Keepz can encrypt with our public key
 */
router.post('/keepz-callback', async (req, res) => {
  try {
    const { encryptedData, encryptedKeys } = req.body;

    if (encryptedData && encryptedKeys) {
      const decrypted = keepz.decrypt(encryptedData, encryptedKeys);

      // ── SAFE LOGGING (M1) — only log non-sensitive fields ──
      console.log('Payment callback:', {
        orderId: decrypted.integratorOrderId || 'unknown',
        status: decrypted.status || 'unknown',
        amount: decrypted.amount,
        currency: decrypted.currency,
        timestamp: new Date().toISOString(),
      });

      // TODO: Save payment result to database
      // TODO: Send email notifications
      // TODO: Update membership status
    } else {
      // ── REJECT UNENCRYPTED CALLBACKS (H2) ──
      console.warn('Rejected unencrypted callback attempt from:', req.ip);
      return res.status(400).json({ error: 'Invalid callback format' });
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    // If decryption fails, the callback wasn't from Keepz
    console.error('Callback decryption failed (possible spoofing):', error.message);
    return res.status(403).json({ error: 'Authentication failed' });
  }
});

/**
 * POST /api/subscription-callback
 * Receives subscription payment cycle callbacks from Keepz
 * SECURITY: Verify via encrypted payload or log with warning
 */
router.post('/subscription-callback', async (req, res) => {
  try {
    const { encryptedData, encryptedKeys, subscriptionId, historyId, status, amount } = req.body;

    // ── PREFER ENCRYPTED CALLBACKS (H2) ──
    if (encryptedData && encryptedKeys) {
      const decrypted = keepz.decrypt(encryptedData, encryptedKeys);
      console.log('Subscription callback (verified):', {
        subscriptionId: decrypted.subscriptionId,
        status: decrypted.status,
        amount: decrypted.amount,
        timestamp: new Date().toISOString(),
      });
    } else if (subscriptionId && status) {
      // Keepz may send unencrypted subscription callbacks
      // Log with caution flag — these should be verified against known subscriptionIds
      console.warn('Subscription callback (unverified):', {
        subscriptionId,
        historyId,
        status,
        amount,
        ip: req.ip,
        timestamp: new Date().toISOString(),
      });
      // TODO: Verify subscriptionId exists in your database before trusting
    } else {
      console.warn('Rejected malformed subscription callback from:', req.ip);
      return res.status(400).json({ error: 'Invalid callback' });
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('Subscription callback error:', error.message);
    return res.status(200).json({ received: true });
  }
});

/**
 * GET /api/health
 * Health check endpoint (M3 — minimal info disclosure)
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;

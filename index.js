const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_API_KEY);
const { google } = require('googleapis');
const Airtable = require('airtable');

const app = express();
app.use(express.raw({ type: 'application/json' }));
app.use(express.json());

// Initialize services
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base('appUNIsu8KgvOlmi0');
let oauth2Client;

// Logs storage
const logs = [];
const addLog = (message, level = 'info') => {
  const logEntry = { timestamp: new Date().toISOString(), level, message };
  logs.push(logEntry);
  console.log(`[${level.toUpperCase()}] ${message}`);
  if (logs.length > 100) logs.shift();
};

// Initialize Gmail OAuth
async function initializeGmail() {
  try {
    const auth = JSON.parse(process.env.GMAIL_CREDENTIALS);
    oauth2Client = new google.auth.OAuth2(
      auth.client_id,
      auth.client_secret,
      auth.redirect_uris[0]
    );
    oauth2Client.setCredentials({
      refresh_token: auth.refresh_token
    });
    addLog('Gmail OAuth initialized successfully');
  } catch (error) {
    addLog(`Failed to initialize Gmail: ${error.message}`, 'error');
  }
}

// Send Gmail alert
async function sendGmailAlert(failedPayment) {
  try {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    
    const subject = `Payment Failed Alert - ${failedPayment.customerEmail || 'Unknown Customer'}`;
    const body = `Payment Failure Alert

Payment Details:
- Payment ID: ${failedPayment.paymentId}
- Customer Email: ${failedPayment.customerEmail || 'Not available'}
- Amount: ${failedPayment.amount} ${failedPayment.currency.toUpperCase()}
- Failure Reason: ${failedPayment.failureReason}
- Timestamp: ${failedPayment.timestamp}

Please review this failed payment and take appropriate action.`;

    const message = [
      'Content-Type: text/plain; charset="UTF-8"',
      'MIME-Version: 1.0',
      `Subject: ${subject}`,
      '',
      body
    ].join('\n');

    const encodedMessage = Buffer.from(message)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedMessage,
      },
    });

    addLog(`Gmail alert sent for payment ${failedPayment.paymentId}`);
    return true;
  } catch (error) {
    addLog(`Failed to send Gmail alert: ${error.message}`, 'error');
    return false;
  }
}

// Update Airtable with failed payment
async function updateAirtable(failedPayment) {
  try {
    await base('Failed Payments').create([
      {
        fields: {
          'Payment ID': failedPayment.paymentId,
          'Customer Email': failedPayment.customerEmail || 'Unknown',
          'Amount': failedPayment.amount,
          'Currency': failedPayment.currency.toUpperCase(),
          'Failure Reason': failedPayment.failureReason,
          'Timestamp': failedPayment.timestamp,
          'Status': 'Failed'
        }
      }
    ]);
    
    addLog(`Added failed payment ${failedPayment.paymentId} to Airtable`);
    return true;
  } catch (error) {
    addLog(`Failed to update Airtable: ${error.message}`, 'error');
    return false;
  }
}

// Process failed payment
async function processFailedPayment(paymentData) {
  const failedPayment = {
    paymentId: paymentData.id,
    customerEmail: paymentData.customer_email || paymentData.receipt_email,
    amount: (paymentData.amount || 0) / 100,
    currency: paymentData.currency || 'usd',
    failureReason: paymentData.failure_message || paymentData.outcome?.seller_message || 'Unknown reason',
    timestamp: new Date().toISOString()
  };

  addLog(`Processing failed payment: ${failedPayment.paymentId}`);

  await sendGmailAlert(failedPayment);
  await updateAirtable(failedPayment);
}

// Routes
app.get('/', (req, res) => {
  res.json({
    message: 'Stripe Payment Monitor Agent',
    status: 'running',
    endpoints: {
      'GET /': 'This status page',
      'GET /health': 'Health check',
      'GET /logs': 'View recent logs',
      'POST /webhook': 'Stripe webhook endpoint',
      'POST /test': 'Manual test run'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    services: {
      stripe: !!process.env.STRIPE_API_KEY,
      gmail: !!oauth2Client,
      airtable: !!process.env.AIRTABLE_API_KEY
    }
  });
});

app.get('/logs', (req, res) => {
  res.json({ logs: logs.slice(-50) });
});

app.post('/webhook', (req, res) => {
  const sig = req.headers['stripe-signature'];
  
  try {
    const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || 'temp');
    
    addLog(`Received Stripe webhook: ${event.type}`);

    if (event.type === 'payment_intent.payment_failed' || 
        event.type === 'charge.failed' ||
        event.type === 'invoice.payment_failed') {
      
      const paymentData = event.data.object;
      processFailedPayment(paymentData);
    }

    res.json({ received: true });
  } catch (error) {
    addLog(`Webhook error: ${error.message}`, 'error');
    res.status(400).send(`Webhook Error: ${error.message}`);
  }
});

app.post('/test', async (req, res) => {
  try {
    addLog('Running manual test...');
    
    const testPayment = {
      id: 'test_payment_' + Date.now(),
      customer_email: 'test@example.com',
      amount: 2500,
      currency: 'usd',
      failure_message: 'Test failed payment for monitoring system'
    };

    await processFailedPayment(testPayment);
    
    addLog('Manual test completed successfully');
    res.json({ 
      success: true, 
      message: 'Test alert sent and Airtable updated',
      testPayment
    });
  } catch (error) {
    addLog(`Manual test failed: ${error.message}`, 'error');
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

async function initialize() {
  addLog('Starting Stripe Payment Monitor Agent...');
  await initializeGmail();
  addLog('Agent initialization complete');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await initialize();
  addLog(`Stripe Payment Monitor Agent running on port ${PORT}`);
});
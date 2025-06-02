require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const cors = require('cors');
const nodemailer = require('nodemailer');
const axios = require('axios');
const crypto = require('crypto');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GMAIL_PASS = process.env.GMAIL_PASS;

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: '19rueneuve@gmail.com',
    pass: GMAIL_PASS
  }
});

const app = express();
app.use(cors());
app.use(express.json()); // per le rotte normali

// CREA CHECKOUT SESSION
app.post('/create-checkout-session', async (req, res) => {
  const { total, orderDetailsLong } = req.body;
  console.log("✅ Richiesta ricevuta:", req.body);

  let numericTotal = parseFloat(total);
  const orderId = crypto.randomUUID().slice(0, 8); // ID breve ordine
  const preMessage = `📋 *Minibar – ${orderId}*\n\n${orderDetailsLong}`;

  if (isNaN(numericTotal) || numericTotal <= 0) {
    console.error("❌ Totale non valido:", total);
    return res.status(400).json({ error: "❌ L'importo totale non è valido." });
  }

  // Caso REGALO (< 0.50 €)
  if (numericTotal < 0.5) {
    console.log("🎁 Totale < 0.50€, invio Ordine Regalo");
    await sendMail('Ordine Regalo', preMessage);
    await sendTelegramNotification('Ordine Regalo', preMessage);

    return res.json({
      redirect: "https://neadesign.github.io/minibar/thank-you.html"
    });
  }

  // Caso ≥ 0.50 €
  console.log("💳 Ordine ≥ 0.50€, invio Ordine in Attesa di Pagamento");
  await sendMail('Ordine in Attesa di Pagamento', preMessage);
  await sendTelegramNotification('Ordine in Attesa di Pagamento', preMessage);

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: 'Minibar Order' },
          unit_amount: Math.round(numericTotal * 100) // prezzo pieno
        },
        quantity: 1
      }],
      mode: 'payment',
      success_url: 'https://neadesign.github.io/Zielinska/success001.html',
      cancel_url: 'https://neadesign.github.io/Zielinska/cancel001.html',
      metadata: {
        source: 'minibar'
      }
    });

    console.log('✅ Sessione Stripe creata:', session.id);

    res.json({ url: session.url });
  } catch (err) {
    console.error('❌ Errore creazione sessione Stripe:', err.message);
    res.status(500).json({ error: 'Errore interno creazione sessione Stripe' });
  }
});

// WEBHOOK — usa RAW per verifica firma
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    console.log('✅ Webhook ricevuto:', event.type);
  } catch (err) {
    console.error('❌ Webhook verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const source = (session.metadata?.source || '').toLowerCase();

    if (source === 'minibar') {
      console.log(`💰 Ordine PAGATO per Minibar`);
      const message = `💰 *Minibar* (Pagato)\n\nSessione: ${session.id}`;
      await sendMail('Ordine Pagato', message);
      await sendTelegramNotification('Ordine Pagato', message);
    } else {
      console.log(`⛔ Webhook ignorato: source ≠ 'minibar' (trovato: '${source}')`);
    }
  }

  if (event.type === 'checkout.session.expired') {
    const session = event.data.object;
    const source = (session.metadata?.source || '').toLowerCase();

    if (source === 'minibar') {
      console.log(`⚠️ Ordine ABBANDONATO per Minibar`);
      const message = `⚠️ *Minibar* (Ordine Abbandonato)\n\nSessione: ${session.id}`;
      await sendMail('Ordine Abbandonato', message);
      await sendTelegramNotification('Ordine Abbandonato', message);
    } else {
      console.log(`⛔ Webhook ignorato: source ≠ 'minibar' (trovato: '${source}')`);
    }
  }

  res.sendStatus(200);
});

// START SERVER
const PORT = process.env.PORT || 10001;
app.listen(PORT, () => {
  console.log(`🚀 Minibar Server attivo su http://localhost:${PORT}`);
});

// FUNZIONI SUPPORTO
async function sendMail(subject, message) {
  try {
    await transporter.sendMail({
      from: 'Minibar Neaspace <design@francescorossi.co>',
      to: 'design@francescorossi.co',
      subject: subject,
      text: message
    });
    console.log(`📧 Mail inviata: ${subject}`);
  } catch (err) {
    console.error(`❌ Errore invio mail: ${subject}`, err.message);
  }
}

async function sendTelegramNotification(subject, message) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'Markdown'
    });
    console.log(`✅ Notifica Telegram inviata: ${subject}`);
  } catch (err) {
    console.error(`❌ Errore invio Telegram: ${subject}`, err.message);
  }
}

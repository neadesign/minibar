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

const sessionOrderDetails = new Map();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: '19rueneuve@gmail.com',
    pass: GMAIL_PASS
  }
});

const app = express();
app.use(cors());

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
    console.log('🔍 Webhook ricevuto con source:', source);

    if (source === 'minibar') {
        const orderId = session.metadata?.orderId || 'Ordine';
        let summary = session.metadata?.orderDetails || '⚠️ Nessun dettaglio ordine';
        if (sessionOrderDetails.has(session.id)) {
            summary = sessionOrderDetails.get(session.id);
        }

        // If total is below 5€, send "Ordine Regalo" email
        if (session.metadata?.total <= 5) {
            const message = `🎁 *Minibar – ${orderId}* (Regalo)\n\n${summary}`;
            await sendMail('Ordine Regalo', message);
            await sendTelegramNotification('Ordine Regalo', message);
        } 
        // If payment status is 'paid' and total is above 5€, send "Ordine Pagato" email
        else if (session.payment_status === 'paid') {
            const message = `💰 *Minibar – ${orderId}* (Pagato)\n\n${summary}`;
            await sendMail('Ordine Pagato', message);
            await sendTelegramNotification('Ordine Pagato', message);
        }
        // If payment status is not 'paid' and total is above 5€, send "Ordine in Attesa di Pagamento" email
        else {
            const message = `🧺 *Minibar – ${orderId}*\n\n${summary}`;
            await sendMail('Ordine in Attesa di Pagamento', message);
            await sendTelegramNotification('Ordine in Attesa di Pagamento', message);
        }
    } else {
        console.log(`⛔ Webhook ignorato: source ≠ 'minibar' (trovato: '${source}')`);
    }
}



  res.sendStatus(200);
});

app.use(express.json());

app.post('/create-checkout-session', async (req, res) => {
  const { total, orderDetailsShort, orderDetailsLong, delivery_date, phone } = req.body;

  console.log("✅ Richiesta ricevuta:", req.body);

  let numericTotal = parseFloat(total);

  // Se il totale è inferiore a 5€, non inviare Stripe
  if (numericTotal < 5) {
    // Invia un messaggio di regalo
    console.log("✅ Ordine inferiore a 5€, invio messaggio regalo");

    // Redirige alla pagina di conferma senza Stripe
    return res.json({
      redirect: "https://neadesign.github.io/Zielinska/thank-you.html"  // Pagina di conferma "Regalo"
    });
  }

  if (isNaN(numericTotal) || numericTotal <= 0) {
    console.error("❌ Totale non valido:", total);
    return res.status(400).json({ error: "❌ L'importo totale non è valido." });
  }

  const orderId = crypto.randomUUID().slice(0, 8);
  const preMessage = `📥 *Nuovo ordine MINIBAR in attesa di pagamento – ${orderId}*\n\n${orderDetailsLong}`;

  try {
    await transporter.sendMail({
      from: 'Minibar Neaspace <design@francescorossi.co>',
      to: 'design@francescorossi.co',
      subject: `🧺 Nuovo ordine minibar – ${orderId}`,
      text: preMessage.replace(/\*/g, '')
    });

    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: preMessage,
      parse_mode: 'Markdown'
    });

    console.log('📧 Email + Telegram inviati PRIMA del pagamento');
  } catch (err) {
    console.error('❌ Errore invio Email o Telegram:', err.message);
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: 'Minibar Order' },
          unit_amount: Math.round(numericTotal * 100) // Applica il totale corretto in centesimi
        },
        quantity: 1
      }],
      mode: 'payment',
      success_url: 'https://neadesign.github.io/Zielinska/success001.html',
      cancel_url: 'https://neadesign.github.io/Zielinska/cancel001.html',
      metadata: {
        source: 'minibar' // Identificativo dell'origine dell'ordine
      }
    });

    sessionOrderDetails.set(session.id, orderDetailsLong);
    console.log('✅ Sessione Stripe creata:', session.id);
    res.json({ url: session.url });

  } catch (err) {
    console.error('❌ Errore creazione sessione Stripe:', err.message);
    res.status(500).json({ error: 'Errore interno creazione sessione Stripe' });
  }
});

// Funzione per inviare mail
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

// Funzione per inviare notifiche Telegram
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

const PORT = process.env.PORT || 10001;
app.listen(PORT, () => {
  console.log(`🚀 Minibar Server attivo su http://localhost:${PORT}`);
});

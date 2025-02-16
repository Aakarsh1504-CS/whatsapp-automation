const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Global error handlers to prevent server crash
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Setup multer for file uploads with diskStorage to retain original file extensions
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    // Extract the original extension
    const ext = path.extname(file.originalname);
    // Generate a unique filename with the original extension
    const filename = `${Date.now()}${ext}`;
    cb(null, filename);
  }
});
const upload = multer({ storage: storage });

// Serve static files (for the frontend HTML/CSS/JS)
app.use(express.static('public'));

// Utility delay function
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Map to store client instances by socket id
const clients = {};

// When a user connects via Socket.IO, create a new WhatsApp client for that user
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Create a new WhatsApp client instance for this socket
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: socket.id }), // Each instance has its own session
    puppeteer: { 
      headless: true,
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  client.on('qr', (qr) => {
    console.log(`QR Code received for socket ${socket.id}`);
    qrcode.toDataURL(qr, (err, url) => {
      if (err) {
        console.error('Error generating QR code', err);
        return;
      }
      socket.emit('qr', url);
    });
  });

  client.on('ready', () => {
    console.log(`WhatsApp client ready for socket ${socket.id}`);
    socket.emit('ready', 'WhatsApp is connected!');
  });

  client.on('authenticated', () => {
    console.log(`Client authenticated for socket ${socket.id}`);
  });

  client.on('auth_failure', (msg) => {
    console.error(`Authentication failed for socket ${socket.id}:`, msg);
    socket.emit('auth_failure', msg);
  });

  client.on('disconnected', () => {
    console.warn(`Client disconnected for socket ${socket.id}.`);
    socket.emit('disconnected', 'Client disconnected, please refresh to try again.');
    try {
      if (clients[socket.id]) clients[socket.id].destroy();
    } catch (e) {
      console.error('Error during client destroy:', e);
    }
    delete clients[socket.id];
  });

  client.initialize();
  clients[socket.id] = client;

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    try {
      if (clients[socket.id]) {
        clients[socket.id].destroy();
      }
    } catch (e) {
      console.error('Error destroying client on disconnect:', e);
    }
    delete clients[socket.id];
  });
});

// Endpoint to handle form submission for sending messages.
app.post('/send', upload.fields([
  { name: 'excelFile', maxCount: 1 },
  { name: 'imageFile', maxCount: 1 },
  { name: 'pdfFile', maxCount: 1 }
]), async (req, res) => {
  try {
    // Expect a socketId field from the form data
    const { socketId } = req.body;
    const client = clients[socketId];

    if (!client || !client.info || !client.info.wid) {
      return res.status(400).send('WhatsApp client is not authenticated for your session. Please scan the QR code.');
    }

    // Extract up to 10 text messages from separate fields (message1, message2, ..., message10)
    const messages = [];
    for (let i = 1; i <= 10; i++) {
      const msg = req.body[`message${i}`];
      if (msg && msg.trim()) {
        messages.push(msg.trim());
      }
    }
    if (messages.length === 0) {
      return res.status(400).send('At least one text message must be provided.');
    }

    // Retrieve file paths while preserving original extensions
    const excelFilePath = req.files.excelFile[0].path;
    const imageFile = req.files.imageFile ? req.files.imageFile[0] : null;
    const imagePath = imageFile ? imageFile.path : null;
    const pdfFile = req.files.pdfFile ? req.files.pdfFile[0] : null;
    const pdfPath = pdfFile ? pdfFile.path : null;

    // Read the Excel file using ExcelJS
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(excelFilePath);
    const worksheet = workbook.worksheets[0];

    // Extract phone numbers (assuming they're in the first column; skip header row)
    const numbers = [];
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // skip header
      const cellValue = row.getCell(1).value;
      if (cellValue) {
        numbers.push(cellValue.toString());
      }
    });

    // Remove the Excel file once processed
    fs.unlinkSync(excelFilePath);

    // Loop through contacts and send messages with delay logic
    for (let i = 0; i < numbers.length; i++) {
      // Check if the client is still active
      if (!client || !client.info || !client.info.wid) {
        console.warn(`Client for socket ${socketId} is no longer active. Stopping sends.`);
        break;
      }

      const number = numbers[i];
      const chatId = `91${number}@c.us`;

      // If an image is provided, send it first
      if (imagePath) {
        try {
          const media = MessageMedia.fromFilePath(imagePath);
          await client.sendMessage(chatId, media);
          console.log(`Image message sent to ${chatId}`);
        } catch (err) {
          console.error(`Failed to send image to ${chatId}:`, err);
        }
        await delay(2500);
      }

      // If a PDF is provided, send it next with original filename preserved
      if (pdfPath && pdfFile) {
        try {
          let pdfMedia = MessageMedia.fromFilePath(pdfPath);
          pdfMedia.filename = pdfFile.originalname;
          await client.sendMessage(chatId, pdfMedia);
          console.log(`PDF message sent to ${chatId} with filename: ${pdfFile.originalname}`);
        } catch (err) {
          console.error(`Failed to send PDF to ${chatId}:`, err);
        }
        await delay(2500);
      }

      // Send each text message sequentially
      for (const text of messages) {
        try {
          await client.sendMessage(chatId, text);
          console.log(`Text message sent to ${chatId}: ${text}`);
        } catch (err) {
          console.error(`Failed to send text to ${chatId}:`, err);
        }
        await delay(2500);
      }

      // After every 100 contacts, add an extra 4-second delay
      if ((i + 1) % 100 === 0) {
        console.log(`Sent messages to ${i + 1} contacts. Adding an extra 4-second delay.`);
        await delay(4000);
      }

      // After every 250 contacts, add an extra 5-hour delay
      if ((i + 1) % 250 === 0) {
        console.log(`Sent messages to ${i + 1} contacts. Adding an extra 5-hour delay.`);
        await delay(5 * 3600 * 1000); // 5 hours in milliseconds
      }
    }

    // Clean up the image and PDF files after sending all messages
    if (imagePath) fs.unlinkSync(imagePath);
    if (pdfPath) fs.unlinkSync(pdfPath);

    res.send('Messages have been sent.');
  } catch (error) {
    console.error('Error processing the request:', error);
    res.status(500).send('There was an error processing your request.');
  }
});

server.listen(3000, () => {
  console.log('Server is running on port 3000');
});

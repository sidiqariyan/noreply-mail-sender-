const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { MongoClient } = require('mongodb');
const nodemailer = require('nodemailer');
const { exec } = require('child_process');

const app = express();
const PORT = 5000;

const MONGO_URI = 'mongodb+srv://recoveryis123:123@cluster0.8zrgys7.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';  
const DB_NAME = 'emailService';
const COLLECTION_NAME = 'jobs';

const client = new MongoClient(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });

// Enhanced logging function
function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  
  if (data) {
    console.log(logMessage, JSON.stringify(data, null, 2));
  } else {
    console.log(logMessage);
  }
}

// Email transporter configurations for localhost
const createTransporters = () => {
  const transporters = [];

  // 1. Sendmail (Linux/Unix systems)
  try {
    const sendmailTransporter = nodemailer.createTransport({
      sendmail: true,
      newline: 'unix',
      path: '/usr/sbin/sendmail'
    });
    transporters.push({ name: 'Sendmail', transporter: sendmailTransporter });
  } catch (error) {
    log('warn', 'Sendmail transporter failed to initialize', error.message);
  }

  // 2. Local SMTP (if postfix/exim is running)
  try {
    const localSMTPTransporter = nodemailer.createTransport({
      host: 'localhost',
      port: 25,
      secure: false,
      ignoreTLS: true,
      tls: {
        rejectUnauthorized: false
      }
    });
    transporters.push({ name: 'Local SMTP', transporter: localSMTPTransporter });
  } catch (error) {
    log('warn', 'Local SMTP transporter failed to initialize', error.message);
  }

  // 3. Alternative local SMTP port
  try {
    const altSMTPTransporter = nodemailer.createTransport({
      host: '127.0.0.1',
      port: 587,
      secure: false,
      ignoreTLS: true,
      tls: {
        rejectUnauthorized: false
      }
    });
    transporters.push({ name: 'Alt SMTP', transporter: altSMTPTransporter });
  } catch (error) {
    log('warn', 'Alternative SMTP transporter failed to initialize', error.message);
  }

  // 4. JSON transport for testing (saves to file)
  const jsonTransporter = nodemailer.createTransport({
    jsonTransport: true
  });
  transporters.push({ name: 'JSON File', transporter: jsonTransporter });

  return transporters;
};

let transporters = createTransporters();

// Middleware
app.use(cors());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP'
});
app.use('/api/', limiter);

// MongoDB connection
async function connectToDatabase() {
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection(COLLECTION_NAME);
    
    await collection.createIndex({ jobId: 1 }, { unique: true });
    log('info', `Connected to MongoDB at ${MONGO_URI}`);
    return { db, collection };
  } catch (error) {
    log('error', 'MongoDB connection failed', error);
    process.exit(1);
  }
}

// Check system mail configuration
async function checkSystemMailConfig() {
  const checks = {
    sendmail: false,
    postfix: false,
    exim: false,
    mailq: false
  };

  try {
    // Check for sendmail
    await new Promise((resolve, reject) => {
      exec('which sendmail', (error, stdout) => {
        checks.sendmail = !error && stdout.trim().length > 0;
        resolve();
      });
    });

    // Check for postfix
    await new Promise((resolve, reject) => {
      exec('systemctl is-active postfix', (error, stdout) => {
        checks.postfix = !error && stdout.trim() === 'active';
        resolve();
      });
    });

    // Check for exim
    await new Promise((resolve, reject) => {
      exec('systemctl is-active exim4', (error, stdout) => {
        checks.exim = !error && stdout.trim() === 'active';
        resolve();
      });
    });

    // Check mail queue
    await new Promise((resolve, reject) => {
      exec('mailq', (error, stdout) => {
        checks.mailq = !error;
        resolve();
      });
    });

  } catch (error) {
    log('warn', 'Error checking system mail config', error.message);
  }

  return checks;
}

// Enhanced email sending function
async function sendEmailWithFallback(to, subject, message, fromName, fromEmail) {
  log('info', `Attempting to send email to ${to}`, { subject, fromName, fromEmail });
  
  const errors = [];
  
  for (const { name, transporter } of transporters) {
    try {
      log('debug', `Trying ${name} transporter for ${to}`);
      
      const mailOptions = {
        from: `${fromName} <${fromEmail}>`,
        to: to,
        subject: subject,
        html: message,
        text: message.replace(/<[^>]*>/g, ''), // Strip HTML for text version
        headers: {
          'X-Mailer': 'Node.js Email Sender',
          'X-Priority': '3'
        }
      };

      const info = await transporter.sendMail(mailOptions);
      
      // Handle different response types
      let result = {
        recipient: to,
        success: true,
        method: name,
        timestamp: new Date().toISOString()
      };

      if (name === 'JSON File') {
        // JSON transport returns the email as JSON
        const emailData = JSON.parse(info.message);
        result.messageData = emailData;
        log('info', `Email saved to JSON for ${to}`, emailData);
        
        // Save to file for debugging
        const emailsDir = path.join(__dirname, 'sent_emails');
        if (!fs.existsSync(emailsDir)) {
          fs.mkdirSync(emailsDir);
        }
        const fileName = `email_${Date.now()}_${to.replace(/[^a-zA-Z0-9]/g, '_')}.json`;
        fs.writeFileSync(path.join(emailsDir, fileName), JSON.stringify(emailData, null, 2));
        
      } else {
        result.messageId = info.messageId;
        result.response = info.response;
        log('info', `Email sent successfully via ${name} to ${to}`, { 
          messageId: info.messageId,
          response: info.response 
        });
      }
      
      return result;
      
    } catch (error) {
      log('warn', `${name} transporter failed for ${to}`, error.message);
      errors.push({ method: name, error: error.message });
      continue;
    }
  }
  
  // All transporters failed
  log('error', `All email methods failed for ${to}`, errors);
  return {
    recipient: to,
    success: false,
    errors: errors,
    timestamp: new Date().toISOString()
  };
}

// Routes
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Node.js email sender is running',
    transporters: transporters.length,
    timestamp: new Date().toISOString()
  });
});

// System configuration check
app.get('/api/system-check', async (req, res) => {
  try {
    const systemChecks = await checkSystemMailConfig();
    
    // Test each transporter
    const transporterStatus = [];
    for (const { name, transporter } of transporters) {
      try {
        if (name !== 'JSON File') {
          await transporter.verify();
          transporterStatus.push({ name, status: 'working' });
        } else {
          transporterStatus.push({ name, status: 'available' });
        }
      } catch (error) {
        transporterStatus.push({ name, status: 'failed', error: error.message });
      }
    }
    
    res.json({
      system: systemChecks,
      transporters: transporterStatus,
      recommendations: generateRecommendations(systemChecks, transporterStatus)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function generateRecommendations(systemChecks, transporterStatus) {
  const recommendations = [];
  
  if (!systemChecks.sendmail) {
    recommendations.push('Install sendmail: sudo apt-get install sendmail');
  }
  
  if (!systemChecks.postfix && !systemChecks.exim) {
    recommendations.push('Install mail server: sudo apt-get install postfix');
  }
  
  const workingTransporters = transporterStatus.filter(t => t.status === 'working').length;
  if (workingTransporters === 0) {
    recommendations.push('Configure a mail server on localhost');
    recommendations.push('Emails will be saved as JSON files for testing');
  }
  
  return recommendations;
}

// Test email endpoint
app.post('/api/test-email', async (req, res) => {
  try {
    const { to, fromName = 'Test Sender', fromEmail = 'noreply@localhost' } = req.body;
    
    if (!to) {
      return res.status(400).json({ error: 'Recipient email is required' });
    }
    
    const testSubject = `Test Email - ${new Date().toISOString()}`;
    const testMessage = `
      <html>
        <body>
          <h1>🧪 Test Email</h1>
          <p>This is a test email sent from your Node.js email server.</p>
          <p><strong>Sent at:</strong> ${new Date().toISOString()}</p>
          <p><strong>Server:</strong> localhost:${PORT}</p>
          <hr>
          <p><small>If you received this email, your email configuration is working!</small></p>
        </body>
      </html>
    `;
    
    const result = await sendEmailWithFallback(to, testSubject, testMessage, fromName, fromEmail);
    
    res.json(result);
  } catch (error) {
    log('error', 'Test email failed', error);
    res.status(500).json({ error: error.message });
  }
});

// Bulk email endpoint
app.post('/api/send-bulk', async (req, res) => {
  try {
    const { recipients, subject, message, fromName, fromEmail } = req.body;
    
    log('info', 'Bulk email request received', { 
      recipientCount: recipients?.length,
      subject,
      fromName,
      fromEmail 
    });
    
    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: 'Recipients array is required' });
    }
    
    if (!subject || !message) {
      return res.status(400).json({ error: 'Subject and message are required' });
    }
    
    // Validate email addresses
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const invalidEmails = recipients.filter(email => !emailRegex.test(email.trim()));
    if (invalidEmails.length > 0) {
      return res.status(400).json({ 
        error: 'Invalid email addresses found',
        invalidEmails 
      });
    }
    
    const emailContent = {
      subject,
      message,
      fromName: fromName || 'No Reply',
      fromEmail: fromEmail || 'noreply@localhost'
    };
    
    const jobId = Date.now().toString();
    const { collection } = await connectToDatabase();
    
    log('info', `Starting bulk email job ${jobId}`, { 
      recipients: recipients.length,
      emailContent 
    });
    
    // Initialize job in MongoDB
    await collection.insertOne({
      jobId,
      status: 'processing',
      total: recipients.length,
      processed: 0,
      successful: 0,
      failed: 0,
      results: [],
      emailContent,
      startedAt: new Date(),
      server: 'localhost'
    });
    
    // Start bulk sending (async)
    sendBulkEmails(recipients, emailContent, jobId, collection);
    
    res.json({
      success: true,
      jobId,
      message: `Started sending ${recipients.length} emails`,
      status: 'processing',
      server: 'localhost'
    });
    
  } catch (error) {
    log('error', 'Bulk email error', error);
    res.status(500).json({ error: error.message });
  }
});

async function sendBulkEmails(recipients, emailContent, jobId, collection) {
  log('info', `Processing bulk email job ${jobId}`, { recipients: recipients.length });
  
  let successful = 0;
  let failed = 0;
  
  for (let i = 0; i < recipients.length; i++) {
    const recipient = recipients[i].trim();
    
    try {
      log('debug', `Sending email ${i + 1}/${recipients.length} to ${recipient}`);
      
      const result = await sendEmailWithFallback(
        recipient,
        emailContent.subject,
        emailContent.message,
        emailContent.fromName,
        emailContent.fromEmail
      );
      
      if (result.success) {
        successful++;
        log('info', `✅ Email sent successfully to ${recipient}`, { method: result.method });
      } else {
        failed++;
        log('warn', `❌ Email failed to ${recipient}`, result.errors);
      }
      
      // Update job progress in MongoDB
      await collection.updateOne(
        { jobId },
        {
          $inc: { 
            processed: 1, 
            successful: result.success ? 1 : 0, 
            failed: result.success ? 0 : 1 
          },
          $push: { results: result },
          $set: { 
            status: 'processing',
            lastUpdate: new Date(),
            progressPercentage: Math.round(((i + 1) / recipients.length) * 100)
          }
        }
      );
      
      log('debug', `Job ${jobId} progress: ${i + 1}/${recipients.length} (${successful} success, ${failed} failed)`);
      
    } catch (error) {
      failed++;
      log('error', `Unexpected error sending to ${recipient}`, error);
      
      await collection.updateOne(
        { jobId },
        {
          $inc: { processed: 1, failed: 1 },
          $push: { 
            results: { 
              recipient, 
              success: false, 
              error: error.message,
              timestamp: new Date().toISOString()
            } 
          },
          $set: { 
            status: 'processing',
            lastUpdate: new Date(),
            progressPercentage: Math.round(((i + 1) / recipients.length) * 100)
          }
        }
      );
    }
    
    // Delay between emails to avoid overwhelming
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  
  // Mark job as completed
  const successRate = ((successful / recipients.length) * 100).toFixed(2);
  await collection.updateOne(
    { jobId },
    {
      $set: {
        status: 'completed',
        completedAt: new Date(),
        progressPercentage: 100,
        summary: {
          total: recipients.length,
          successful,
          failed,
          successRate: successRate + '%'
        }
      }
    }
  );
  
  log('info', `✅ Bulk email job ${jobId} completed`, { 
    total: recipients.length, 
    successful, 
    failed,
    successRate: successRate + '%'
  });
}

// Job status endpoints
app.get('/api/job/:jobId', async (req, res) => {
  try {
    const { collection } = await connectToDatabase();
    const job = await collection.findOne({ jobId: req.params.jobId });
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    
    res.json(job);
  } catch (error) {
    log('error', 'Error fetching job status', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/jobs', async (req, res) => {
  try {
    const { collection } = await connectToDatabase();
    const jobs = await collection.find({})
      .sort({ startedAt: -1 })
      .limit(50)
      .toArray();
    
    res.json(jobs);
  } catch (error) {
    log('error', 'Error fetching jobs', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/job/:jobId', async (req, res) => {
  try {
    const { collection } = await connectToDatabase();
    const result = await collection.deleteOne({ jobId: req.params.jobId });
    
    if (result.deletedCount === 1) {
      log('info', `Job ${req.params.jobId} deleted`);
      res.json({ success: true, message: 'Job deleted' });
    } else {
      res.status(404).json({ error: 'Job not found' });
    }
  } catch (error) {
    log('error', 'Error deleting job', error);
    res.status(500).json({ error: error.message });
  }
});

// View sent emails (JSON files)
app.get('/api/sent-emails', (req, res) => {
  try {
    const emailsDir = path.join(__dirname, 'sent_emails');
    if (!fs.existsSync(emailsDir)) {
      return res.json({ emails: [], message: 'No sent emails directory found' });
    }
    
    const files = fs.readdirSync(emailsDir)
      .filter(file => file.endsWith('.json'))
      .map(file => {
        const filePath = path.join(emailsDir, file);
        const stats = fs.statSync(filePath);
        const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        
        return {
          filename: file,
          created: stats.ctime,
          size: stats.size,
          to: content.to,
          subject: content.subject
        };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));
    
    res.json({ emails: files });
  } catch (error) {
    log('error', 'Error reading sent emails', error);
    res.status(500).json({ error: error.message });
  }
});

// Start server
async function startServer() {
  try {
    // Test MongoDB connection first
    await connectToDatabase();
    
    // Check system mail configuration
    const systemChecks = await checkSystemMailConfig();
    log('info', 'System mail configuration', systemChecks);
    
    // Start Express server
    app.listen(PORT, () => {
      log('info', `🚀 Node.js email server running on port ${PORT}`);
      log('info', `📧 Available transporters: ${transporters.length}`);
      
      console.log('\n📋 API Endpoints:');
      console.log(`GET  /api/health - Server health check`);
      console.log(`GET  /api/system-check - Check email system configuration`);
      console.log(`POST /api/test-email - Send test email`);
      console.log(`POST /api/send-bulk - Send bulk emails`);
      console.log(`GET  /api/job/:jobId - Check job status`);
      console.log(`GET  /api/jobs - Get all jobs`);
      console.log(`GET  /api/sent-emails - View sent emails (JSON files)`);
      console.log(`DELETE /api/job/:jobId - Delete job`);
      
      console.log('\n🔧 Setup Instructions:');
      console.log('1. Install mail server: sudo apt-get install sendmail');
      console.log('2. Or install postfix: sudo apt-get install postfix');
      console.log('3. Test configuration: curl http://localhost:5000/api/system-check');
      console.log('4. Send test email: curl -X POST http://localhost:5000/api/test-email -H "Content-Type: application/json" -d \'{"to":"test@example.com"}\'');
      
      console.log('\n📁 Note: If no mail server is configured, emails will be saved as JSON files in ./sent_emails/ directory');
    });
  } catch (error) {
    log('error', 'Failed to start server', error);
    process.exit(1);
  }
}

startServer();

// Cleanup on exit
process.on('SIGINT', async () => {
  log('info', '👋 Shutting down server...');
  await client.close();
  process.exit(0);
});
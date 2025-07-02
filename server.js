const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { MongoClient } = require('mongodb');
const nodemailer = require('nodemailer');

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

// Configure nodemailer transporter (more reliable than PHP mail)
const transporter = nodemailer.createTransporter({
  host: 'localhost', // Use local sendmail
  port: 25,
  secure: false,
  tls: {
    rejectUnauthorized: false
  },
  // Fallback to sendmail if SMTP fails
  sendmail: true,
  newline: 'unix',
  path: '/usr/sbin/sendmail'
});

// Test email configuration on startup
async function testEmailConfig() {
  try {
    await transporter.verify();
    log('info', 'Email transporter is ready');
    return true;
  } catch (error) {
    log('warn', 'Email transporter verification failed, will use PHP fallback', error);
    return false;
  }
}

// Enhanced PHP mail script with better error reporting
const phpScript = `<?php
error_reporting(E_ALL);
ini_set('display_errors', 1);

function sendEmail($to, $subject, $message, $fromName, $fromEmail) {
    // More comprehensive headers
    $headers = "MIME-Version: 1.0" . "\\r\\n";
    $headers .= "Content-type:text/html;charset=UTF-8" . "\\r\\n";
    $headers .= "From: " . $fromName . " <" . $fromEmail . ">" . "\\r\\n";
    $headers .= "Reply-To: " . $fromEmail . "\\r\\n";
    $headers .= "Return-Path: " . $fromEmail . "\\r\\n";
    $headers .= "X-Mailer: PHP/" . phpversion() . "\\r\\n";
    $headers .= "X-Priority: 3" . "\\r\\n";
    
    // Log the attempt
    error_log("Attempting to send email to: $to");
    error_log("Subject: $subject");
    error_log("From: $fromName <$fromEmail>");
    
    $result = mail($to, $subject, $message, $headers);
    
    if ($result) {
        error_log("PHP mail() returned SUCCESS for $to");
    } else {
        error_log("PHP mail() returned FAILED for $to");
        $error = error_get_last();
        if ($error) {
            error_log("Last error: " . print_r($error, true));
        }
    }
    
    return $result;
}

// Validate input
if ($argc < 6) {
    echo "ERROR: Insufficient arguments";
    exit(1);
}

$to = $argv[1];
$subject = $argv[2];
$message = $argv[3];
$fromName = $argv[4];
$fromEmail = $argv[5];

// Validate email
if (!filter_var($to, FILTER_VALIDATE_EMAIL)) {
    echo "ERROR: Invalid recipient email";
    exit(1);
}

if (!filter_var($fromEmail, FILTER_VALIDATE_EMAIL)) {
    echo "ERROR: Invalid sender email";
    exit(1);
}

$result = sendEmail($to, $subject, $message, $fromName, $fromEmail);
echo $result ? "SUCCESS" : "FAILED";
?>`;

const phpScriptPath = path.join(__dirname, 'send_mail.php');
fs.writeFileSync(phpScriptPath, phpScript);

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
    
    // Create index for jobId uniqueness
    await collection.createIndex({ jobId: 1 }, { unique: true });
    log('info', `Connected to MongoDB at ${MONGO_URI}`);
    return { db, collection };
  } catch (error) {
    log('error', 'MongoDB connection failed', error);
    process.exit(1);
  }
}

// Helper functions
function escapeShellArg(arg) {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

// Enhanced email sending with both nodemailer and PHP fallback
async function sendEmailViaPHP(to, subject, message, fromName, fromEmail) {
  return new Promise((resolve) => {
    const command = `php ${phpScriptPath} ${escapeShellArg(to)} ${escapeShellArg(subject)} ${escapeShellArg(message)} ${escapeShellArg(fromName)} ${escapeShellArg(fromEmail)}`;
    
    log('debug', `Executing PHP command for ${to}`);
    
    exec(command, (error, stdout, stderr) => {
      const result = {
        recipient: to,
        method: 'PHP',
        timestamp: new Date().toISOString()
      };

      if (error) {
        log('error', `PHP execution error for ${to}`, error);
        result.success = false;
        result.error = error.message;
        result.details = stderr;
      } else {
        const output = stdout.trim();
        log('debug', `PHP output for ${to}: ${output}`);
        
        if (stderr) {
          log('warn', `PHP stderr for ${to}: ${stderr}`);
        }
        
        result.success = output === 'SUCCESS';
        result.output = output;
        result.phpErrors = stderr;
        
        if (!result.success) {
          log('warn', `PHP mail failed for ${to}`, { output, stderr });
        }
      }
      
      resolve(result);
    });
  });
}

// Nodemailer email sending
async function sendEmailViaNodemailer(to, subject, message, fromName, fromEmail) {
  try {
    log('debug', `Sending email via Nodemailer to ${to}`);
    
    const info = await transporter.sendMail({
      from: `${fromName} <${fromEmail}>`,
      to: to,
      subject: subject,
      html: message,
      text: message.replace(/<[^>]*>/g, '') // Strip HTML for text version
    });
    
    log('info', `Nodemailer success for ${to}`, { messageId: info.messageId });
    
    return {
      recipient: to,
      success: true,
      method: 'Nodemailer',
      messageId: info.messageId,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    log('error', `Nodemailer failed for ${to}`, error);
    return {
      recipient: to,
      success: false,
      method: 'Nodemailer',
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

// Combined email sending function
async function sendEmail(to, subject, message, fromName, fromEmail) {
  log('info', `Attempting to send email to ${to}`);
  
  // Try Nodemailer first
  const nodemailerResult = await sendEmailViaNodemailer(to, subject, message, fromName, fromEmail);
  
  if (nodemailerResult.success) {
    return nodemailerResult;
  }
  
  // Fallback to PHP
  log('warn', `Nodemailer failed for ${to}, trying PHP fallback`);
  const phpResult = await sendEmailViaPHP(to, subject, message, fromName, fromEmail);
  
  return phpResult;
}

// Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Bulk email sender is running' });
});

// Email configuration test endpoint
app.get('/api/test-config', async (req, res) => {
  try {
    const nodemailerTest = await testEmailConfig();
    
    // Test PHP mail configuration
    const phpTest = await new Promise((resolve) => {
      exec('php -m | grep -i mail', (error, stdout, stderr) => {
        resolve(!error && stdout.includes('mail'));
      });
    });
    
    // Check sendmail
    const sendmailTest = await new Promise((resolve) => {
      exec('which sendmail', (error, stdout) => {
        resolve(!error && stdout.trim().length > 0);
      });
    });
    
    res.json({
      nodemailer: nodemailerTest,
      phpMail: phpTest,
      sendmail: sendmailTest,
      recommendations: {
        nodemailer: nodemailerTest ? 'Working' : 'Install and configure mail server',
        phpMail: phpTest ? 'Available' : 'PHP mail extension not found',
        sendmail: sendmailTest ? 'Available' : 'Install sendmail: sudo apt-get install sendmail'
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test email endpoint
app.post('/api/test-email', async (req, res) => {
  try {
    const { to, fromName = 'Test Sender', fromEmail = 'noreply@vedive.com' } = req.body;
    
    if (!to) {
      return res.status(400).json({ error: 'Recipient email is required' });
    }
    
    const result = await sendEmail(
      to,
      'Test Email - ' + new Date().toISOString(),
      '<h1>Test Email</h1><p>This is a test email sent at ' + new Date().toISOString() + '</p>',
      fromName,
      fromEmail
    );
    
    res.json(result);
  } catch (error) {
    log('error', 'Test email failed', error);
    res.status(500).json({ error: error.message });
  }
});

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
    
    const emailContent = {
      subject,
      message,
      fromName: fromName || 'No Reply',
      fromEmail: fromEmail || 'noreply@vedive.com'
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
      startedAt: new Date()
    });
    
    // Start bulk sending (async)
    sendBulkEmails(recipients, emailContent, jobId, collection);
    
    res.json({
      success: true,
      jobId,
      message: `Started sending ${recipients.length} emails`,
      status: 'processing'
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
    const recipient = recipients[i];
    
    try {
      log('debug', `Sending email ${i + 1}/${recipients.length} to ${recipient}`);
      
      const result = await sendEmail(
        recipient,
        emailContent.subject,
        emailContent.message,
        emailContent.fromName,
        emailContent.fromEmail
      );
      
      if (result.success) {
        successful++;
        log('info', `Email sent successfully to ${recipient}`, result);
      } else {
        failed++;
        log('warn', `Email failed to ${recipient}`, result);
      }
      
      // Update job progress in MongoDB
      await collection.updateOne(
        { jobId },
        {
          $inc: { processed: 1, successful: result.success ? 1 : 0, failed: result.success ? 0 : 1 },
          $push: { results: result },
          $set: { 
            status: 'processing',
            lastUpdate: new Date()
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
            lastUpdate: new Date()
          }
        }
      );
    }
    
    // Small delay to avoid overwhelming the server
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  // Mark job as completed
  await collection.updateOne(
    { jobId },
    {
      $set: {
        status: 'completed',
        completedAt: new Date(),
        summary: {
          total: recipients.length,
          successful,
          failed,
          successRate: ((successful / recipients.length) * 100).toFixed(2) + '%'
        }
      }
    }
  );
  
  log('info', `Bulk email job ${jobId} completed`, { 
    total: recipients.length, 
    successful, 
    failed,
    successRate: ((successful / recipients.length) * 100).toFixed(2) + '%'
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
    
    // Add real-time progress calculation
    if (job.total > 0) {
      job.progressPercentage = Math.round((job.processed / job.total) * 100);
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
    
    // Add progress percentage to each job
    jobs.forEach(job => {
      if (job.total > 0) {
        job.progressPercentage = Math.round((job.processed / job.total) * 100);
      }
    });
    
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

// Start server
async function startServer() {
  try {
    // Test MongoDB connection first
    const { db } = await connectToDatabase();
    
    // Test email configuration
    await testEmailConfig();
    
    // Start Express server
    app.listen(PORT, () => {
      log('info', `Bulk email server running on port ${PORT}`);
      log('info', `PHP mail script created at: ${phpScriptPath}`);
      console.log('\nAPI Endpoints:');
      console.log(`GET  /api/health - Server health check`);
      console.log(`GET  /api/test-config - Test email configuration`);
      console.log(`POST /api/test-email - Send test email`);
      console.log(`POST /api/send-bulk - Send bulk emails`);
      console.log(`GET  /api/job/:jobId - Check job status`);
      console.log(`GET  /api/jobs - Get all jobs`);
      console.log(`DELETE /api/job/:jobId - Delete job`);
      console.log('\nDebugging tips:');
      console.log('1. Test email config: GET /api/test-config');
      console.log('2. Send test email: POST /api/test-email with {"to": "your-email@domain.com"}');
      console.log('3. Check server logs for detailed debugging info');
    });
  } catch (error) {
    log('error', 'Failed to start server', error);
    process.exit(1);
  }
}

startServer();

// Cleanup on exit
process.on('SIGINT', async () => {
  log('info', 'Cleaning up...');
  if (fs.existsSync(phpScriptPath)) {
    fs.unlinkSync(phpScriptPath);
  }
  await client.close();
  process.exit(0);
});
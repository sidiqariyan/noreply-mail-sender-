const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = 5000;

const MONGO_URI = 'mongodb+srv://recoveryis123:123@cluster0.8zrgys7.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';  
const DB_NAME = 'emailService';
const COLLECTION_NAME = 'jobs';

const client = new MongoClient(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });

// PHP mail script setup
const phpScript = `<?php
function sendEmail($to, $subject, $message, $fromName, $fromEmail) {
    $headers = "MIME-Version: 1.0" . "\\r\\n";
    $headers .= "Content-type:text/html;charset=UTF-8" . "\\r\\n";
    $headers .= "From: " . $fromName . " <" . $fromEmail . ">" . "\\r\\n";
    $headers .= "Reply-To: " . $fromEmail . "\\r\\n";
    
    return mail($to, $subject, $message, $headers);
}

$to = $argv[1];
$subject = $argv[2];
$message = $argv[3];
$fromName = $argv[4];
$fromEmail = $argv[5];

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
    console.log(`Connected to MongoDB at ${MONGO_URI}`);
    return { db, collection };
  } catch (error) {
    console.error('MongoDB connection failed:', error);
    process.exit(1);
  }
}

// Helper functions
function escapeShellArg(arg) {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

function sendEmailViaPHP(to, subject, message, fromName, fromEmail) {
  return new Promise((resolve) => {
    const command = `php ${phpScriptPath} ${escapeShellArg(to)} ${escapeShellArg(subject)} ${escapeShellArg(message)} ${escapeShellArg(fromName)} ${escapeShellArg(fromEmail)}`;
    
    exec(command, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: error.message });
      } else {
        resolve({ 
          success: stdout.trim() === 'SUCCESS', 
          output: stdout.trim(),
          error: stderr
        });
      }
    });
  });
}

// Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Bulk email sender is running' });
});

app.post('/api/send-bulk', async (req, res) => {
  try {
    const { recipients, subject, message, fromName, fromEmail } = req.body;
    
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
    
    // Initialize job in MongoDB
    await collection.insertOne({
      jobId,
      status: 'started',
      total: recipients.length,
      processed: 0,
      results: [],
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
    res.status(500).json({ error: error.message });
  }
});

async function sendBulkEmails(recipients, emailContent, jobId, collection) {
  for (let i = 0; i < recipients.length; i++) {
    const recipient = recipients[i];
    
    const result = await sendEmailViaPHP(
      recipient,
      emailContent.subject,
      emailContent.message,
      emailContent.fromName,
      emailContent.fromEmail
    );
    
    // Update job progress in MongoDB
    await collection.updateOne(
      { jobId },
      {
        $inc: { processed: 1 },
        $push: { results: { recipient, ...result } },
        $set: { status: 'processing' }
      }
    );
    
    // Small delay to avoid overwhelming the server
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  // Mark job as completed
  await collection.updateOne(
    { jobId },
    {
      $set: {
        status: 'completed',
        completedAt: new Date()
      }
    }
  );
}

// Single email endpoint

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
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/jobs', async (req, res) => {
  try {
    const { collection } = await connectToDatabase();
    const jobs = await collection.find({}).toArray();
    res.json(jobs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/job/:jobId', async (req, res) => {
  try {
    const { collection } = await connectToDatabase();
    const result = await collection.deleteOne({ jobId: req.params.jobId });
    
    if (result.deletedCount === 1) {
      res.json({ success: true, message: 'Job deleted' });
    } else {
      res.status(404).json({ error: 'Job not found' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
async function startServer() {
  try {
    // Test MongoDB connection first
    const { db } = await connectToDatabase();
    
    // Start Express server
    app.listen(PORT, () => {
      console.log(`Bulk email server running on port ${PORT}`);
      console.log(`PHP mail script created at: ${phpScriptPath}`);
      console.log('\nAPI Endpoints:');
      console.log(`POST /api/send-bulk - Send bulk emails`);
      console.log(`POST /api/send-single - Send single email`);
      console.log(`GET /api/job/:jobId - Check job status`);
      console.log(`GET /api/jobs - Get all jobs`);
      console.log(`DELETE /api/job/:jobId - Delete job`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

// Cleanup on exit
process.on('SIGINT', async () => {
  console.log('\nCleaning up...');
  if (fs.existsSync(phpScriptPath)) {
    fs.unlinkSync(phpScriptPath);
  }
  await client.close();
  process.exit(0);
});
const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const validator = require('validator');
const nodemailer = require('nodemailer');
const Redis = require('redis');
const { MongoClient } = require('mongodb');
const winston = require('winston');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Environment variables validation
const requiredEnvVars = [
  'MONGO_URI', 'JWT_SECRET', 'SMTP_HOST', 
  'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'
];

requiredEnvVars.forEach(envVar => {
  if (!process.env[envVar]) {
    console.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
});

// Logger setup
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Database connection with connection pooling
const mongoClient = new MongoClient(process.env.MONGO_URI, {
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
});

// Redis client for job queue
const redisClient = Redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});

// Email transporter setup
const emailTransporter = nodemailer.createTransporter({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: process.env.SMTP_PORT === '465',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  pool: true,
  maxConnections: 5,
  maxMessages: 100,
});

// Security middleware
app.use(helmet());
app.use(express.json({ limit: '10mb' }));

// CORS with specific origin
app.use(require('cors')({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  credentials: true
}));

// Rate limiting - more restrictive for production
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const bulkEmailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // Only 3 bulk email jobs per hour
  message: 'Bulk email limit exceeded. Please try again later.',
});

app.use('/api/', apiLimiter);
app.use('/api/send-bulk', bulkEmailLimiter);

// Authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// Input validation functions
const validateEmail = (email) => {
  return validator.isEmail(email) && email.length <= 254;
};

const validateEmailContent = (subject, message) => {
  if (!subject || subject.length > 998) return false;
  if (!message || message.length > 50000) return false;
  
  // Basic HTML sanitization check
  const dangerousPatterns = [
    /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
    /javascript:/gi,
    /on\w+\s*=/gi
  ];
  
  return !dangerousPatterns.some(pattern => pattern.test(message));
};

// Database connection helper
async function getDatabase() {
  try {
    if (!mongoClient.topology || !mongoClient.topology.isConnected()) {
      await mongoClient.connect();
    }
    return mongoClient.db(process.env.DB_NAME || 'emailService');
  } catch (error) {
    logger.error('Database connection failed:', error);
    throw new Error('Database unavailable');
  }
}

// Email sending function
async function sendEmail(to, subject, message, fromName, fromEmail) {
  try {
    const mailOptions = {
      from: `${fromName} <${fromEmail}>`,
      to: to,
      subject: subject,
      html: message,
      // Add text version for better deliverability
      text: message.replace(/<[^>]*>/g, ''),
    };

    const result = await emailTransporter.sendMail(mailOptions);
    return { success: true, messageId: result.messageId };
  } catch (error) {
    logger.error('Email sending failed:', { to, error: error.message });
    return { success: false, error: error.message };
  }
}

// Routes
app.get('/api/health', async (req, res) => {
  try {
    // Check database connection
    const db = await getDatabase();
    await db.admin().ping();
    
    // Check email service
    await emailTransporter.verify();
    
    res.json({ 
      status: 'OK', 
      timestamp: new Date().toISOString(),
      services: {
        database: 'connected',
        email: 'connected'
      }
    });
  } catch (error) {
    logger.error('Health check failed:', error);
    res.status(503).json({ 
      status: 'ERROR', 
      error: 'Service unavailable' 
    });
  }
});

app.post('/api/send-bulk', authenticateToken, async (req, res) => {
  try {
    const { recipients, subject, message, fromName, fromEmail } = req.body;
    
    // Validation
    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: 'Recipients array is required' });
    }
    
    if (recipients.length > 1000) {
      return res.status(400).json({ error: 'Maximum 1000 recipients allowed per job' });
    }
    
    // Validate all email addresses
    const invalidEmails = recipients.filter(email => !validateEmail(email));
    if (invalidEmails.length > 0) {
      return res.status(400).json({ 
        error: 'Invalid email addresses found',
        invalidEmails: invalidEmails.slice(0, 10) // Show first 10 invalid emails
      });
    }
    
    if (!validateEmailContent(subject, message)) {
      return res.status(400).json({ error: 'Invalid subject or message content' });
    }
    
    if (fromEmail && !validateEmail(fromEmail)) {
      return res.status(400).json({ error: 'Invalid from email address' });
    }
    
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const db = await getDatabase();
    const collection = db.collection('jobs');
    
    // Initialize job record
    await collection.insertOne({
      jobId,
      userId: req.user.id,
      status: 'queued',
      total: recipients.length,
      processed: 0,
      successful: 0,
      failed: 0,
      results: [],
      emailContent: {
        subject,
        message,
        fromName: fromName || 'No Reply',
        fromEmail: fromEmail || process.env.DEFAULT_FROM_EMAIL
      },
      createdAt: new Date(),
      startedAt: null,
      completedAt: null
    });
    
    // Queue the job for background processing
    await redisClient.lPush('email_jobs', JSON.stringify({
      jobId,
      recipients,
      emailContent: {
        subject,
        message,
        fromName: fromName || 'No Reply',
        fromEmail: fromEmail || process.env.DEFAULT_FROM_EMAIL
      }
    }));
    
    logger.info('Bulk email job queued', { jobId, recipients: recipients.length, userId: req.user.id });
    
    res.json({
      success: true,
      jobId,
      message: `Queued ${recipients.length} emails for sending`,
      status: 'queued'
    });
    
  } catch (error) {
    logger.error('Bulk email endpoint error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/send-single', authenticateToken, async (req, res) => {
  try {
    const { to, subject, message, fromName, fromEmail } = req.body;
    
    if (!validateEmail(to)) {
      return res.status(400).json({ error: 'Invalid recipient email address' });
    }
    
    if (!validateEmailContent(subject, message)) {
      return res.status(400).json({ error: 'Invalid subject or message content' });
    }
    
    const result = await sendEmail(
      to,
      subject,
      message,
      fromName || 'No Reply',
      fromEmail || process.env.DEFAULT_FROM_EMAIL
    );
    
    logger.info('Single email sent', { to, success: result.success, userId: req.user.id });
    
    res.json(result);
    
  } catch (error) {
    logger.error('Single email endpoint error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/job/:jobId', authenticateToken, async (req, res) => {
  try {
    const db = await getDatabase();
    const collection = db.collection('jobs');
    const job = await collection.findOne({ 
      jobId: req.params.jobId,
      userId: req.user.id // Users can only see their own jobs
    });
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    
    // Remove sensitive data from response
    delete job.emailContent.message;
    delete job.results;
    
    res.json(job);
  } catch (error) {
    logger.error('Job status endpoint error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/jobs', authenticateToken, async (req, res) => {
  try {
    const db = await getDatabase();
    const collection = db.collection('jobs');
    const jobs = await collection.find(
      { userId: req.user.id },
      { 
        projection: { 
          emailContent: 0, 
          results: 0 
        } 
      }
    ).sort({ createdAt: -1 }).limit(50).toArray();
    
    res.json(jobs);
  } catch (error) {
    logger.error('Jobs list endpoint error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Background job processor (should be in separate worker process in production)
async function processEmailJobs() {
  while (true) {
    try {
      const jobData = await redisClient.brPop('email_jobs', 10);
      if (!jobData) continue;
      
      const job = JSON.parse(jobData.element);
      const db = await getDatabase();
      const collection = db.collection('jobs');
      
      // Update job status to processing
      await collection.updateOne(
        { jobId: job.jobId },
        { 
          $set: { 
            status: 'processing',
            startedAt: new Date()
          } 
        }
      );
      
      logger.info('Processing email job', { jobId: job.jobId });
      
      let successful = 0;
      let failed = 0;
      
      // Process emails with delay to avoid rate limiting
      for (const recipient of job.recipients) {
        const result = await sendEmail(
          recipient,
          job.emailContent.subject,
          job.emailContent.message,
          job.emailContent.fromName,
          job.emailContent.fromEmail
        );
        
        if (result.success) {
          successful++;
        } else {
          failed++;
        }
        
        // Update progress
        await collection.updateOne(
          { jobId: job.jobId },
          {
            $inc: { processed: 1, successful: result.success ? 1 : 0, failed: result.success ? 0 : 1 }
          }
        );
        
        // Delay between emails to respect rate limits
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      // Mark job as completed
      await collection.updateOne(
        { jobId: job.jobId },
        {
          $set: {
            status: 'completed',
            completedAt: new Date()
          }
        }
      );
      
      logger.info('Email job completed', { 
        jobId: job.jobId, 
        successful, 
        failed, 
        total: job.recipients.length 
      });
      
    } catch (error) {
      logger.error('Job processing error:', error);
      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait before retrying
    }
  }
}

// Start background job processor
processEmailJobs();

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  await mongoClient.close();
  await redisClient.quit();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  await mongoClient.close();
  await redisClient.quit();
  process.exit(0);
});

// Start server
app.listen(PORT, () => {
  logger.info(`Email service running on port ${PORT}`);
});

module.exports = app;

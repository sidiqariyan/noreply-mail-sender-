<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

// Handle preflight requests
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    exit(0);
}

// MongoDB connection settings
$mongoUri = 'mongodb+srv://recoveryis123:123@cluster0.8zrgys7.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';
$dbName = 'emailService';
$collectionName = 'jobs';

// Simple logging function
function logMessage($level, $message, $data = null) {
    $timestamp = date('Y-m-d\TH:i:s.v\Z');
    $logEntry = "[$timestamp] [$level] $message";
    
    if ($data) {
        $logEntry .= ' ' . json_encode($data);
    }
    
    echo $logEntry . "\n";
    
    // Also write to log file
    file_put_contents('email_server.log', $logEntry . "\n", FILE_APPEND | LOCK_EX);
}

// Enhanced mail function with better headers
function sendEmail($to, $subject, $message, $fromName = 'No Reply', $fromEmail = 'noreply@localhost') {
    // Clean inputs
    $to = filter_var(trim($to), FILTER_SANITIZE_EMAIL);
    $subject = trim($subject);
    $fromName = trim($fromName);
    $fromEmail = filter_var(trim($fromEmail), FILTER_SANITIZE_EMAIL);
    
    // Validate email
    if (!filter_var($to, FILTER_VALIDATE_EMAIL)) {
        return [
            'success' => false,
            'error' => 'Invalid recipient email address',
            'recipient' => $to
        ];
    }
    
    if (!filter_var($fromEmail, FILTER_VALIDATE_EMAIL)) {
        return [
            'success' => false,
            'error' => 'Invalid sender email address',
            'recipient' => $to
        ];
    }
    
    // Set up headers for better delivery
    $headers = [];
    $headers[] = "MIME-Version: 1.0";
    $headers[] = "Content-type: text/html; charset=UTF-8";
    $headers[] = "From: $fromName <$fromEmail>";
    $headers[] = "Reply-To: $fromEmail";
    $headers[] = "Return-Path: $fromEmail";
    $headers[] = "X-Mailer: PHP Email Server";
    $headers[] = "X-Priority: 3";
    $headers[] = "Message-ID: <" . uniqid() . "@" . $_SERVER['SERVER_NAME'] . ">";
    $headers[] = "Date: " . date('r');
    
    $headerString = implode("\r\n", $headers);
    
    // Add HTML wrapper if message doesn't contain HTML tags
    if (strip_tags($message) === $message) {
        $htmlMessage = "
        <html>
        <head><title>$subject</title></head>
        <body>
            <div style='font-family: Arial, sans-serif; line-height: 1.6; color: #333;'>
                " . nl2br(htmlspecialchars($message)) . "
            </div>
        </body>
        </html>";
    } else {
        $htmlMessage = $message;
    }
    
    // Attempt to send email
    $result = mail($to, $subject, $htmlMessage, $headerString);
    
    if ($result) {
        logMessage('INFO', "✅ Email sent successfully to $to", [
            'subject' => $subject,
            'method' => 'PHP mail()'
        ]);
        
        return [
            'success' => true,
            'recipient' => $to,
            'method' => 'PHP mail()',
            'timestamp' => date('c')
        ];
    } else {
        $error = error_get_last();
        logMessage('ERROR', "❌ Email failed to $to", [
            'subject' => $subject,
            'error' => $error['message'] ?? 'Unknown error'
        ]);
        
        return [
            'success' => false,
            'recipient' => $to,
            'error' => $error['message'] ?? 'Mail function returned false',
            'timestamp' => date('c')
        ];
    }
}

// MongoDB connection helper
function getMongoCollection() {
    global $mongoUri, $dbName, $collectionName;
    
    try {
        $client = new MongoDB\Client($mongoUri);
        $db = $client->selectDatabase($dbName);
        $collection = $db->selectCollection($collectionName);
        
        logMessage('INFO', "Connected to MongoDB");
        return $collection;
    } catch (Exception $e) {
        logMessage('ERROR', 'MongoDB connection failed', ['error' => $e->getMessage()]);
        return null;
    }
}

// Check system mail configuration
function checkSystemMailConfig() {
    $checks = [
        'php_mail' => function_exists('mail'),
        'sendmail_path' => ini_get('sendmail_path'),
        'smtp' => ini_get('SMTP'),
        'smtp_port' => ini_get('smtp_port'),
        'mail_log' => ini_get('mail.log')
    ];
    
    // Test if sendmail is available
    $sendmailExists = false;
    if (function_exists('exec')) {
        exec('which sendmail 2>/dev/null', $output, $returnCode);
        $sendmailExists = ($returnCode === 0);
    }
    $checks['sendmail_available'] = $sendmailExists;
    
    return $checks;
}

// Router
$requestUri = $_SERVER['REQUEST_URI'];
$requestMethod = $_SERVER['REQUEST_METHOD'];

// Remove query string and normalize path
$path = strtok($requestUri, '?');
$path = rtrim($path, '/');

// Route handling
switch ($path) {
    case '/api/health':
        if ($requestMethod === 'GET') {
            echo json_encode([
                'status' => 'OK',
                'message' => 'PHP email server is running',
                'php_version' => PHP_VERSION,
                'mail_function' => function_exists('mail'),
                'timestamp' => date('c')
            ]);
        }
        break;
        
    case '/api/system-check':
        if ($requestMethod === 'GET') {
            $systemChecks = checkSystemMailConfig();
            
            $recommendations = [];
            if (!$systemChecks['php_mail']) {
                $recommendations[] = 'PHP mail() function is not available';
            }
            if (!$systemChecks['sendmail_available']) {
                $recommendations[] = 'Install sendmail: sudo apt-get install sendmail';
            }
            if (empty($systemChecks['sendmail_path'])) {
                $recommendations[] = 'Configure sendmail_path in php.ini';
            }
            
            echo json_encode([
                'system' => $systemChecks,
                'recommendations' => $recommendations,
                'mail_test_available' => true
            ]);
        }
        break;
        
    case '/api/test-email':
        if ($requestMethod === 'POST') {
            $input = json_decode(file_get_contents('php://input'), true);
            
            if (!isset($input['to']) || empty($input['to'])) {
                http_response_code(400);
                echo json_encode(['error' => 'Recipient email is required']);
                break;
            }
            
            $to = $input['to'];
            $fromName = $input['fromName'] ?? 'Test Sender';
            $fromEmail = $input['fromEmail'] ?? 'noreply@localhost';
            
            $testSubject = "Test Email - " . date('Y-m-d H:i:s');
            $testMessage = "
            <h1>🧪 Test Email</h1>
            <p>This is a test email sent from your PHP email server.</p>
            <p><strong>Sent at:</strong> " . date('c') . "</p>
            <p><strong>Server:</strong> PHP " . PHP_VERSION . "</p>
            <p><strong>Method:</strong> Built-in mail() function</p>
            <hr>
            <p><small>If you received this email, your PHP mail configuration is working!</small></p>
            ";
            
            $result = sendEmail($to, $testSubject, $testMessage, $fromName, $fromEmail);
            
            if ($result['success']) {
                echo json_encode($result);
            } else {
                http_response_code(500);
                echo json_encode($result);
            }
        }
        break;
        
    case '/api/send-bulk':
        if ($requestMethod === 'POST') {
            $input = json_decode(file_get_contents('php://input'), true);
            
            // Validate input
            if (!isset($input['recipients']) || !is_array($input['recipients']) || empty($input['recipients'])) {
                http_response_code(400);
                echo json_encode(['error' => 'Recipients array is required']);
                break;
            }
            
            if (empty($input['subject']) || empty($input['message'])) {
                http_response_code(400);
                echo json_encode(['error' => 'Subject and message are required']);
                break;
            }
            
            $recipients = $input['recipients'];
            $subject = $input['subject'];
            $message = $input['message'];
            $fromName = $input['fromName'] ?? 'No Reply';
            $fromEmail = $input['fromEmail'] ?? 'noreply@localhost';
            
            logMessage('INFO', 'Bulk email request received', [
                'recipientCount' => count($recipients),
                'subject' => $subject,
                'fromName' => $fromName,
                'fromEmail' => $fromEmail
            ]);
            
            // Validate email addresses
            $invalidEmails = [];
            foreach ($recipients as $email) {
                if (!filter_var(trim($email), FILTER_VALIDATE_EMAIL)) {
                    $invalidEmails[] = $email;
                }
            }
            
            if (!empty($invalidEmails)) {
                http_response_code(400);
                echo json_encode([
                    'error' => 'Invalid email addresses found',
                    'invalidEmails' => $invalidEmails
                ]);
                break;
            }
            
            $jobId = (string)time() . rand(1000, 9999);
            
            // Try to connect to MongoDB (optional)
            $collection = null;
            if (class_exists('MongoDB\Client')) {
                $collection = getMongoCollection();
            }
            
            // Initialize job in MongoDB if available
            if ($collection) {
                try {
                    $collection->insertOne([
                        'jobId' => $jobId,
                        'status' => 'processing',
                        'total' => count($recipients),
                        'processed' => 0,
                        'successful' => 0,
                        'failed' => 0,
                        'results' => [],
                        'emailContent' => [
                            'subject' => $subject,
                            'message' => $message,
                            'fromName' => $fromName,
                            'fromEmail' => $fromEmail
                        ],
                        'startedAt' => new MongoDB\BSON\UTCDateTime(),
                        'server' => 'PHP'
                    ]);
                } catch (Exception $e) {
                    logMessage('WARN', 'Failed to save job to MongoDB', ['error' => $e->getMessage()]);
                }
            }
            
            // Process emails immediately (for smaller batches) or queue for larger batches
            if (count($recipients) <= 10) {
                // Process immediately for small batches
                $results = processBulkEmails($recipients, $subject, $message, $fromName, $fromEmail, $jobId, $collection);
                
                echo json_encode([
                    'success' => true,
                    'jobId' => $jobId,
                    'status' => 'completed',
                    'results' => $results,
                    'processed_immediately' => true
                ]);
            } else {
                // For larger batches, return immediately and process in background
                // Note: In production, you'd want to use a proper queue system
                echo json_encode([
                    'success' => true,
                    'jobId' => $jobId,
                    'message' => "Started sending " . count($recipients) . " emails",
                    'status' => 'processing',
                    'note' => 'Check /api/job/' . $jobId . ' for progress'
                ]);
                
                // Process in background (simplified - in production use proper queue)
                if (function_exists('fastcgi_finish_request')) {
                    fastcgi_finish_request();
                }
                processBulkEmails($recipients, $subject, $message, $fromName, $fromEmail, $jobId, $collection);
            }
        }
        break;
        
    default:
        if (strpos($path, '/api/job/') === 0) {
            $jobId = substr($path, 10); // Remove '/api/job/'
            
            if ($requestMethod === 'GET') {
                // Get job status
                $collection = getMongoCollection();
                if ($collection) {
                    try {
                        $job = $collection->findOne(['jobId' => $jobId]);
                        if ($job) {
                            echo json_encode($job->toArray());
                        } else {
                            http_response_code(404);
                            echo json_encode(['error' => 'Job not found']);
                        }
                    } catch (Exception $e) {
                        http_response_code(500);
                        echo json_encode(['error' => $e->getMessage()]);
                    }
                } else {
                    http_response_code(503);
                    echo json_encode(['error' => 'MongoDB not available']);
                }
            } elseif ($requestMethod === 'DELETE') {
                // Delete job
                $collection = getMongoCollection();
                if ($collection) {
                    try {
                        $result = $collection->deleteOne(['jobId' => $jobId]);
                        if ($result->getDeletedCount() === 1) {
                            echo json_encode(['success' => true, 'message' => 'Job deleted']);
                        } else {
                            http_response_code(404);
                            echo json_encode(['error' => 'Job not found']);
                        }
                    } catch (Exception $e) {
                        http_response_code(500);
                        echo json_encode(['error' => $e->getMessage()]);
                    }
                } else {
                    http_response_code(503);
                    echo json_encode(['error' => 'MongoDB not available']);
                }
            }
        } else {
            http_response_code(404);
            echo json_encode(['error' => 'Endpoint not found']);
        }
        break;
}

// Function to process bulk emails
function processBulkEmails($recipients, $subject, $message, $fromName, $fromEmail, $jobId, $collection) {
    logMessage('INFO', "Processing bulk email job $jobId", ['recipients' => count($recipients)]);
    
    $results = [];
    $successful = 0;
    $failed = 0;
    
    foreach ($recipients as $index => $recipient) {
        $recipient = trim($recipient);
        
        logMessage('DEBUG', "Sending email " . ($index + 1) . "/" . count($recipients) . " to $recipient");
        
        $result = sendEmail($recipient, $subject, $message, $fromName, $fromEmail);
        $results[] = $result;
        
        if ($result['success']) {
            $successful++;
        } else {
            $failed++;
        }
        
        // Update MongoDB progress if available
        if ($collection) {
            try {
                $collection->updateOne(
                    ['jobId' => $jobId],
                    [
                        '$inc' => [
                            'processed' => 1,
                            'successful' => $result['success'] ? 1 : 0,
                            'failed' => $result['success'] ? 0 : 1
                        ],
                        '$push' => ['results' => $result],
                        '$set' => [
                            'status' => 'processing',
                            'lastUpdate' => new MongoDB\BSON\UTCDateTime(),
                            'progressPercentage' => round((($index + 1) / count($recipients)) * 100)
                        ]
                    ]
                );
            } catch (Exception $e) {
                logMessage('WARN', 'Failed to update job progress', ['error' => $e->getMessage()]);
            }
        }
        
        // Small delay to avoid overwhelming the mail system
        usleep(100000); // 100ms delay
    }
    
    // Mark job as completed
    if ($collection) {
        try {
            $successRate = count($recipients) > 0 ? round(($successful / count($recipients)) * 100, 2) : 0;
            $collection->updateOne(
                ['jobId' => $jobId],
                [
                    '$set' => [
                        'status' => 'completed',
                        'completedAt' => new MongoDB\BSON\UTCDateTime(),
                        'progressPercentage' => 100,
                        'summary' => [
                            'total' => count($recipients),
                            'successful' => $successful,
                            'failed' => $failed,
                            'successRate' => $successRate . '%'
                        ]
                    ]
                ]
            );
        } catch (Exception $e) {
            logMessage('WARN', 'Failed to mark job as completed', ['error' => $e->getMessage()]);
        }
    }
    
    logMessage('INFO', "✅ Bulk email job $jobId completed", [
        'total' => count($recipients),
        'successful' => $successful,
        'failed' => $failed,
        'successRate' => round(($successful / count($recipients)) * 100, 2) . '%'
    ]);
    
    return $results;
}

// Display startup information if accessed directly
if (php_sapi_name() === 'cli-server') {
    echo "🚀 PHP Email Server is running!\n";
    echo "📧 Using built-in mail() function\n\n";
    echo "📋 API Endpoints:\n";
    echo "GET  /api/health - Server health check\n";
    echo "GET  /api/system-check - Check email system configuration\n";
    echo "POST /api/test-email - Send test email\n";
    echo "POST /api/send-bulk - Send bulk emails\n";
    echo "GET  /api/job/{jobId} - Check job status\n";
    echo "DELETE /api/job/{jobId} - Delete job\n\n";
    echo "🔧 Test commands:\n";
    echo "curl http://localhost:8000/api/health\n";
    echo "curl -X POST http://localhost:8000/api/test-email -H 'Content-Type: application/json' -d '{\"to\":\"test@example.com\"}'\n\n";
}
?>
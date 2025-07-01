<?php
function sendEmail($to, $subject, $message, $fromName, $fromEmail) {
    $headers = "MIME-Version: 1.0" . "\r\n";
    $headers .= "Content-type:text/html;charset=UTF-8" . "\r\n";
    $headers .= "From: " . $fromName . " <" . $fromEmail . ">" . "\r\n";
    $headers .= "Reply-To: " . $fromEmail . "\r\n";
    
    return mail($to, $subject, $message, $headers);
}

$to = $argv[1];
$subject = $argv[2];
$message = $argv[3];
$fromName = $argv[4];
$fromEmail = $argv[5];

$result = sendEmail($to, $subject, $message, $fromName, $fromEmail);
echo $result ? "SUCCESS" : "FAILED";
?>
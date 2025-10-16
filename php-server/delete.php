<?php
header('Content-Type: text/plain; charset=utf-8');
$file = __DIR__ . '/code.txt';
if (file_exists($file)) {
  if (!@unlink($file)) {
    http_response_code(500);
    echo 'delete error';
    exit;
  }
}
echo 'ok';

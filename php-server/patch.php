<?php
header('Content-Type: text/plain; charset=utf-8');
$code = '';
$method = isset($_SERVER['REQUEST_METHOD']) ? (string)$_SERVER['REQUEST_METHOD'] : '';
$contentType = isset($_SERVER['CONTENT_TYPE']) ? (string)$_SERVER['CONTENT_TYPE'] : (isset($_SERVER['HTTP_CONTENT_TYPE']) ? (string)$_SERVER['HTTP_CONTENT_TYPE'] : '');
if ($method === 'PATCH') {
  $raw = file_get_contents('php://input');
  if ($raw !== false) {
    if (stripos($contentType, 'application/json') !== false) {
      $data = json_decode($raw, true);
      if (is_array($data) && isset($data['code'])) {
        $code = (string)$data['code'];
      }
    } elseif (stripos($contentType, 'application/x-www-form-urlencoded') !== false) {
      $data = [];
      parse_str($raw, $data);
      if (isset($data['code'])) {
        $code = (string)$data['code'];
      }
    } else {
      $data = [];
      parse_str($raw, $data);
      if (isset($data['code'])) {
        $code = (string)$data['code'];
      } else {
        $code = (string)$raw;
      }
    }
  }
}
if ($code === '') {
  $headers = function_exists('getallheaders') ? getallheaders() : [];
  if (isset($headers['Code'])) {
    $code = (string)$headers['Code'];
  } elseif (isset($_SERVER['HTTP_CODE'])) {
    $code = (string)$_SERVER['HTTP_CODE'];
  } elseif (isset($_POST['code'])) {
    $code = $_POST['code'];
  } elseif (isset($_GET['code'])) {
    $code = $_GET['code'];
  }
}
$code = trim((string)$code);
if (!preg_match('/^\d{6}$/', $code)) {
  if (preg_match('/\d{6}/', $code, $m)) {
    $code = $m[0];
  }
}
if (!preg_match('/^\d{6}$/', $code)) {
  http_response_code(400);
  echo 'invalid code';
  exit;
}
$file = __DIR__ . '/code.txt';
if (file_put_contents($file, $code, LOCK_EX) === false) {
  http_response_code(500);
  echo 'write error';
  exit;
}
echo 'ok';

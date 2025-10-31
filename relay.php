<?php
// AUTSYS Relay – versione stabile
header('Content-Type: application/json; charset=utf-8');
$inbox  = __DIR__ . '/inbox.json';
$outbox = __DIR__ . '/outbox.json';

// Se arriva un comando (POST)
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $data = trim(file_get_contents('php://input'));
    if ($data !== '') {
        file_put_contents($inbox, $data . PHP_EOL, FILE_APPEND | LOCK_EX);
        echo json_encode(['status' => 'received', 'ts' => time()]);
    } else {
        echo json_encode(['error' => 'no data']);
    }
    exit;
}

// Se Roberta chiede aggiornamenti (GET)
if (file_exists($outbox) && filesize($outbox) > 0) {
    echo file_get_contents($outbox);
    file_put_contents($outbox, '');
} else {
    echo json_encode(['status' => 'empty']);
}
?>
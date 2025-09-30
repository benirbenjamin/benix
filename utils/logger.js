const fs = require('fs');
const path = require('path');

// Path to logs directory at project root (next to app.js)
const logDirectory = path.join(__dirname, '..', 'logs');

// Create logs directory if it doesn't exist
if (!fs.existsSync(logDirectory)) {
    fs.mkdirSync(logDirectory, { recursive: true });
}

function log(component, type, data, error = null) {
    const timestamp = new Date().toISOString();
    const logEntry = {
        timestamp,
        component,
        type,
        data
    };

    if (error) {
        logEntry.error = {
            message: error.message,
            stack: error.stack,
            code: error.code,
            sqlMessage: error.sqlMessage,
            sqlState: error.sqlState
        };
    }

    const logFile = path.join(logDirectory, `${type}.log`);
    const logMessage = `\n[${timestamp}] ${component}\n${JSON.stringify(logEntry, null, 2)}\n`;

    fs.appendFile(logFile, logMessage, (err) => {
        if (err) {
            console.error('Failed to write to log file:', err);
        }
    });

    // Also log to console based on type
    if (type === 'error') {
        console.error(`[${component}] Error:`, error || data);
    } else {
        console.log(`[${component}] ${type}:`, data);
    }
}

function logError(component, error, additionalInfo = {}) {
    log(component, 'error', additionalInfo, error);
}

function logInfo(component, data) {
    log(component, 'info', data);
}

module.exports = {
    logError,
    logInfo
};
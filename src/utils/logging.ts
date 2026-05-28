import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

let _outputChannel: vscode.OutputChannel | null = null;
let _logFilePath: string | null = null;

export function initLogger(channel: vscode.OutputChannel, logFilePath: string): void {
  _outputChannel = channel;
  _logFilePath = logFilePath;
  // Ensure parent directory exists
  if (!logFilePath) {
    return;
  }
  const dir = path.dirname(logFilePath);
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  }
}

type LogLevel = 'INFO' | 'WARN' | 'ERROR';

function writeLog(message: string, level: LogLevel): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level}] ${message}`;

  _outputChannel?.appendLine(line);

  if (_logFilePath) {
    try {
      fs.appendFileSync(_logFilePath, line + '\n', 'utf8');
    } catch {
      // Silently ignore log write failures so they never break the workflow
    }
  }
}

export function logInfo(message: string): void {
  writeLog(message, 'INFO');
}

export function logWarn(message: string): void {
  writeLog(message, 'WARN');
}

export function logError(message: string): void {
  writeLog(message, 'ERROR');
}

export function log(message: string, level: LogLevel = 'INFO'): void {
  writeLog(message, level);
}

export function getOutputChannel(): vscode.OutputChannel | null {
  return _outputChannel;
}

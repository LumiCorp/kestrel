import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function renderLaunchAgentPlist(input: {
  command: string;
  homeDir: string;
  coreHomeDir?: string | undefined;
}): string {
  const environment = [
    "    <key>KESTREL_HOME</key>",
    `    <string>${escapeXml(input.homeDir)}</string>`,
    ...(input.coreHomeDir !== undefined
      ? [
          "    <key>KESTREL_CORE_HOME</key>",
          `    <string>${escapeXml(input.coreHomeDir)}</string>`,
        ]
      : []),
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    "  <string>com.kestrel.kcron</string>",
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${escapeXml(input.command)}</string>`,
    "    <string>start</string>",
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...environment,
    "  </dict>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export function renderSystemdUserUnit(input: {
  command: string;
  homeDir: string;
  coreHomeDir?: string | undefined;
}): string {
  return [
    "[Unit]",
    "Description=Kestrel kcron user daemon",
    "",
    "[Service]",
    `Environment=KESTREL_HOME=${input.homeDir}`,
    ...(input.coreHomeDir !== undefined ? [`Environment=KESTREL_CORE_HOME=${input.coreHomeDir}`] : []),
    `ExecStart=${input.command} start`,
    "Restart=always",
    "RestartSec=10",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export async function installManagedService(input: {
  command: string;
  homeDir: string;
  coreHomeDir?: string | undefined;
  platform?: NodeJS.Platform | undefined;
}): Promise<string> {
  const platform = input.platform ?? process.platform;
  if (platform === "darwin") {
    const dir = path.join(os.homedir(), "Library", "LaunchAgents");
    const filePath = path.join(dir, "com.kestrel.kcron.plist");
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, renderLaunchAgentPlist(input), "utf8");
    spawnSync("launchctl", ["unload", filePath], { stdio: "ignore" });
    spawnSync("launchctl", ["load", filePath], { stdio: "ignore" });
    return filePath;
  }
  if (platform === "linux") {
    const dir = path.join(os.homedir(), ".config", "systemd", "user");
    const filePath = path.join(dir, "kcron.service");
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, renderSystemdUserUnit(input), "utf8");
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    spawnSync("systemctl", ["--user", "enable", "--now", "kcron.service"], { stdio: "ignore" });
    return filePath;
  }
  throw new Error(`Managed kcron install is unsupported on platform '${platform}'.`);
}

export async function uninstallManagedService(platform: NodeJS.Platform = process.platform): Promise<string> {
  if (platform === "darwin") {
    const filePath = path.join(os.homedir(), "Library", "LaunchAgents", "com.kestrel.kcron.plist");
    spawnSync("launchctl", ["unload", filePath], { stdio: "ignore" });
    await rm(filePath, { force: true });
    return filePath;
  }
  if (platform === "linux") {
    const filePath = path.join(os.homedir(), ".config", "systemd", "user", "kcron.service");
    spawnSync("systemctl", ["--user", "disable", "--now", "kcron.service"], { stdio: "ignore" });
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    await rm(filePath, { force: true });
    return filePath;
  }
  throw new Error(`Managed kcron uninstall is unsupported on platform '${platform}'.`);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

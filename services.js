// services.js
const { exec } = require("child_process");
const os = require("os");

const IS_WINDOWS = os.platform() === "win32";

/**
 * List services based on OS
 * Linux: systemd services
 * Windows: Windows services
 * @returns Promise<Array<{name, load, active, sub, description, platform}>>
 */
function listServices() {
  if (IS_WINDOWS) {
    return listWindowsServices();
  } else {
    return listLinuxServices();
  }
}

/**
 * List systemd services on Linux
 * @returns Promise<Array<{name, load, active, sub, description, platform}>>
 */
function listLinuxServices() {
  return new Promise((resolve, reject) => {
    const cmd =
      'systemctl list-units --type=service --all --no-pager --no-legend';

    exec(cmd, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        return reject(error);
      }

      const lines = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      const services = lines.map((line) => {
        const parts = line.split(/\s+/);

        const name = parts[0] || "";
        const load = parts[1] || "";
        const active = parts[2] || "";
        const sub = parts[3] || "";
        const description = parts.slice(4).join(" ");

        return { name, load, active, sub, description, platform: "linux" };
      });

      resolve(services);
    });
  });
}

/**
 * List Windows services
 * @returns Promise<Array<{name, load, active, sub, description, platform}>>
 */
function listWindowsServices() {
  return new Promise((resolve, reject) => {
    // Get services with Get-Service PowerShell cmdlet
    const cmd = `powershell -Command "Get-Service | Select-Object -Property Name, DisplayName, Status | ConvertTo-Json"`;

    exec(cmd, { maxBuffer: 1024 * 1024, shell: "powershell.exe" }, (error, stdout, stderr) => {
      if (error) {
        return reject(error);
      }

      try {
        const servicesData = JSON.parse(stdout);
        
        // Handle both single service and array of services
        const servicesArray = Array.isArray(servicesData) ? servicesData : [servicesData];
        
        const services = servicesArray.map((svc) => {
          const active = svc.Status === "Running" ? "active" : 
                        svc.Status === "Stopped" ? "inactive" : 
                        "unknown";
          
          return {
            name: svc.Name,
            load: "loaded",
            active: active,
            sub: svc.Status,
            description: svc.DisplayName || svc.Name,
            platform: "windows"
          };
        });

        resolve(services);
      } catch (parseErr) {
        reject(new Error("Failed to parse Windows services: " + parseErr.message));
      }
    });
  });
}

/**
 * Get service status and logs
 * @param {string} serviceName - Service name
 * @returns Promise<{statusText, logsText}>
 */
function getServiceStatus(serviceName) {
  if (IS_WINDOWS) {
    return getWindowsServiceStatus(serviceName);
  } else {
    return getLinuxServiceStatus(serviceName);
  }
}

/**
 * Get Linux service status and logs
 */
function getLinuxServiceStatus(serviceName) {
  return new Promise((resolve, reject) => {
    const statusCmd = `systemctl status ${serviceName} --no-pager`;
    const logsCmd = `journalctl -u ${serviceName} --no-pager -n 200 --output=short-iso`;

    exec(statusCmd, { maxBuffer: 1024 * 1024 }, (statusError, statusStdout) => {
      if (statusError && !statusStdout) {
        return reject(statusError);
      }

      exec(logsCmd, { maxBuffer: 1024 * 1024 }, (logsError, logsStdout) => {
        let logsText = logsError && !logsStdout 
          ? "Could not fetch logs: " + String(logsError)
          : logsStdout.toString();

        resolve({
          statusText: statusStdout.toString(),
          logsText: logsText
        });
      });
    });
  });
}

/**
 * Get Windows service status and logs
 */
function getWindowsServiceStatus(serviceName) {
  return new Promise((resolve, reject) => {
    // Get service status
    const statusCmd = `powershell -Command "Get-Service -Name '${serviceName}' | Select-Object Name, DisplayName, Status, StartType | Format-List"`;
    
    // Get event log for the service (last 50 entries)
    const logsCmd = `powershell -Command "Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Service Control Manager'} -MaxEvents 50 -ErrorAction SilentlyContinue | Where-Object {$_.Message -like '*${serviceName}*'} | Select-Object TimeCreated, Message | Format-List"`;

    exec(statusCmd, { maxBuffer: 1024 * 1024, shell: "powershell.exe" }, (statusError, statusStdout) => {
      const statusText = statusError ? `Error: ${statusError.message}` : statusStdout.toString();

      exec(logsCmd, { maxBuffer: 1024 * 1024, shell: "powershell.exe" }, (logsError, logsStdout) => {
        const logsText = logsError 
          ? "Could not fetch event logs"
          : logsStdout.toString() || "(No recent events found)";

        resolve({
          statusText: statusText,
          logsText: logsText
        });
      });
    });
  });
}

/**
 * Restart a service
 * @param {string} serviceName - Service name
 */
function restartService(serviceName) {
  if (IS_WINDOWS) {
    return restartWindowsService(serviceName);
  } else {
    return restartLinuxService(serviceName);
  }
}

/**
 * Restart Linux service
 */
function restartLinuxService(serviceName) {
  return new Promise((resolve, reject) => {
    const cmd = `systemctl restart ${serviceName}`;
    exec(cmd, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ message: "Service restarted successfully" });
      }
    });
  });
}

/**
 * Restart Windows service
 */
function restartWindowsService(serviceName) {
  return new Promise((resolve, reject) => {
    const cmd = `powershell -Command "Restart-Service -Name '${serviceName}' -Force"`;
    exec(cmd, { maxBuffer: 1024 * 1024, shell: "powershell.exe" }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ message: "Service restarted successfully" });
      }
    });
  });
}

/**
 * Get failed services
 */
function getFailedServices() {
  if (IS_WINDOWS) {
    return getWindowsFailedServices();
  } else {
    return getLinuxFailedServices();
  }
}

/**
 * Get Linux failed services
 */
function getLinuxFailedServices() {
  return new Promise((resolve, reject) => {
    listLinuxServices()
      .then((services) => {
        const failed = services.filter(
          (s) => String(s.active || "").toLowerCase() === "failed"
        );

        const promises = failed.map(
          (svc) =>
            new Promise((resolve) => {
              const showCmd = `systemctl show ${svc.name} -p StateChangeTimestamp -p ActiveEnterTimestamp -p InactiveEnterTimestamp`;
              exec(
                showCmd,
                { maxBuffer: 1024 * 1024 },
                (error, stdout) => {
                  let failedAt = null;
                  if (!error && stdout) {
                    const lines = stdout
                      .toString()
                      .split("\n")
                      .map((l) => l.trim())
                      .filter(Boolean);

                    const readField = (key) => {
                      const line = lines.find((ln) => ln.startsWith(key + "="));
                      if (!line) return null;
                      const value = line.slice(key.length + 1).trim();
                      if (!value || value === "n/a") return null;
                      return value;
                    };

                    failedAt =
                      readField("StateChangeTimestamp") ||
                      readField("InactiveEnterTimestamp") ||
                      readField("ActiveEnterTimestamp");
                  }

                  resolve({
                    name: svc.name,
                    description: svc.description,
                    active: svc.active,
                    sub: svc.sub,
                    load: svc.load,
                    failedAt,
                    platform: "linux"
                  });
                }
              );
            })
        );

        Promise.all(promises).then(resolve).catch(reject);
      })
      .catch(reject);
  });
}

/**
 * Get Windows failed services
 */
function getWindowsFailedServices() {
  return new Promise((resolve, reject) => {
    const cmd = `powershell -Command "Get-Service | Where-Object {$_.Status -eq 'Stopped' -and $_.StartType -eq 'Automatic'} | Select-Object Name, DisplayName, Status, StartType | ConvertTo-Json"`;
    
    exec(cmd, { maxBuffer: 1024 * 1024, shell: "powershell.exe" }, (error, stdout) => {
      if (error) {
        return reject(error);
      }

      try {
        const servicesData = JSON.parse(stdout) || [];
        const servicesArray = Array.isArray(servicesData) ? servicesData : [servicesData];
        
        const failed = servicesArray.map((svc) => ({
          name: svc.Name,
          description: svc.DisplayName || svc.Name,
          active: "inactive",
          sub: svc.Status,
          load: "loaded",
          failedAt: null,
          platform: "windows"
        }));

        resolve(failed);
      } catch (parseErr) {
        reject(new Error("Failed to parse Windows services: " + parseErr.message));
      }
    });
  });
}

module.exports = {
  listServices,
  getServiceStatus,
  restartService,
  getFailedServices,
  IS_WINDOWS,
};


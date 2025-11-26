// services.js
const { exec } = require("child_process");

/**
 * systemd servislerini listeler
 * @returns Promise<Array<{name, load, active, sub, description}>>
 */
function listServices() {
  return new Promise((resolve, reject) => {
    // --no-pager: sayfalama yok
    // --no-legend: üstteki başlık yok
    // --type=service: sadece servisler
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
        // Çıktı genelde şu formda:
        // UNIT LOAD ACTIVE SUB DESCRIPTION
        // alanlar boşlukla ayrılmış ama DESCRIPTION sonunda boşluk içerebilir.
        const parts = line.split(/\s+/);

        const name = parts[0] || "";
        const load = parts[1] || "";
        const active = parts[2] || "";
        const sub = parts[3] || "";
        const description = parts.slice(4).join(" ");

        return { name, load, active, sub, description };
      });

      resolve(services);
    });
  });
}

module.exports = {
  listServices,
};


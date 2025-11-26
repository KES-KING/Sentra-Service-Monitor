-- Schema for Sentra Stat Monitor
-- Adjust database names / users as needed before running.
CREATE USER 'sentrauser25210'@'%' IDENTIFIED BY '_+GSDNtU!;D{1fj!';

-- Main application database
CREATE DATABASE IF NOT EXISTS `sentra_monitor`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE `sentra_monitor`;

GRANT ALL PRIVILEGES ON sentra_monitor.* TO 'sentrauser25210'@'%';

-- Users table for login
CREATE TABLE IF NOT EXISTS `users` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `username` VARCHAR(64) NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_users_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Optional: separate test database used with .testenv
CREATE DATABASE IF NOT EXISTS `sentra_monitor_test`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE `sentra_monitor_test`;

CREATE TABLE IF NOT EXISTS `users` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `username` VARCHAR(64) NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_users_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- To create an initial user (example):
-- 1. Generate a bcrypt hash (using Node, Python, etc.)
-- 2. Insert it into the users table, e.g.:
--
-- INSERT INTO `users` (`username`, `password_hash`)
-- VALUES ('admin', '<bcrypt_hash_here>');

INSERT INTO `users` (`username`, `password_hash`)
VALUES ('admin', '$2a$10$AXdywOLm8aRqO4ofAuDYw.LiUGea1txvLT3RXwx0wEfZjQv.xLk.a');
--- Şifre :  k+@F1U[bkwA=TD9
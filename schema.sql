-- Schema for Sentra Stat Monitor
-- Adjust database names / users as needed before running.
CREATE USER 'sentrauser'@'%' IDENTIFIED BY 'password_here';

-- Main application database
CREATE DATABASE IF NOT EXISTS `sentra_monitor`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE `sentra_monitor`;

GRANT ALL PRIVILEGES ON sentra_monitor.* TO 'sentrauser'@'%';

-- Users table for login
CREATE TABLE IF NOT EXISTS `users` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `username` VARCHAR(64) NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_users_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `users` (`username`, `password_hash`)
VALUES ('admin', '$2a$10$AXdywOLm8aRqO4ofAuDYw.LiUGea1txvLT3RXwx0wEfZjQv.xLk.a');

--- Password :  k+@F1U[bkwA=TD9

-- Agents (registered by X-APP-ID header)
CREATE TABLE IF NOT EXISTS `agents` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` INT UNSIGNED NULL,
  `app_id` VARCHAR(64) NOT NULL,
  `hostname` VARCHAR(255) DEFAULT NULL,
  `os` VARCHAR(255) DEFAULT NULL,
  `last_seen` DATETIME DEFAULT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_agents_app_id` (`app_id`),
  KEY `idx_agents_user` (`user_id`),
  CONSTRAINT `fk_agents_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Agent status snapshots
CREATE TABLE IF NOT EXISTS `agent_status` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `agent_id` INT UNSIGNED NOT NULL,
  `cpu` FLOAT DEFAULT NULL,
  `ram` FLOAT DEFAULT NULL,
  `uptime` INT DEFAULT NULL,
  `timestamp` DATETIME DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_agent_status_agent` (`agent_id`),
  CONSTRAINT `fk_agent_status_agent` FOREIGN KEY (`agent_id`) REFERENCES `agents` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Agent service states
CREATE TABLE IF NOT EXISTS `agent_services` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `agent_id` INT UNSIGNED NOT NULL,
  `service_name` VARCHAR(255) NOT NULL,
  `display_name` VARCHAR(255) DEFAULT NULL,
  `status` VARCHAR(64) DEFAULT NULL,
  `last_updated` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_agent_service` (`agent_id`, `service_name`),
  CONSTRAINT `fk_agent_services_agent` FOREIGN KEY (`agent_id`) REFERENCES `agents` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Service control commands (e.g., restart) queued for agents
CREATE TABLE IF NOT EXISTS `agent_service_commands` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `agent_id` INT UNSIGNED NOT NULL,
  `service_name` VARCHAR(255) NOT NULL,
  `command_type` VARCHAR(32) NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `error_message` TEXT,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `executed_at` DATETIME DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_agent_service_commands_agent` (`agent_id`),
  CONSTRAINT `fk_agent_service_commands_agent` FOREIGN KEY (`agent_id`) REFERENCES `agents` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

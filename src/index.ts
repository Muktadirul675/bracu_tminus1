import { app } from "./app.js";
import { config } from "./config.js";

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`QueueStorm Investigator API listening on port ${config.port}`);
});

server.requestTimeout = config.analyzeTimeoutMs + 1000;
server.headersTimeout = 65_000;

const shutdown = (signal: string): void => {
  console.log(`Received ${signal}. Shutting down gracefully.`);
  server.close(() => {
    process.exit(0);
  });
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

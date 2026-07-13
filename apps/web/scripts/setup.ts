/**
 * Interactive setup script for Better Auth Postgres Starter
 * Run with: pnpm setup or tsx scripts/setup.ts
 *
 * This script:
 * - Checks Node.js version
 * - Generates BETTER_AUTH_SECRET
 * - Prompts for database configuration (with optional Docker setup)
 * - Creates .env and .env.local with configuration
 * - Tests database connection (if postgres package is available)
 */
import { exec } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

const PASSWORD_MASK_REGEX = /:[^:@]+@/;
const EMPTY_STATEMENT_REGEX = /^\s*$/;
const LOCAL_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:58432/better_auth";

function log(message: string, color: keyof typeof colors = "reset") {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function question(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) =>
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans);
    })
  );
}

function checkNodeVersion(): boolean {
  const version = process.version;
  const major = Number.parseInt(version.slice(1).split(".")[0], 10);
  if (major < 18) {
    log(
      `❌ Node.js version ${version} detected. Node.js 18+ is required.`,
      "red"
    );
    return false;
  }
  log(`✅ Node.js ${version} detected`, "green");
  return true;
}

async function checkDocker(): Promise<boolean> {
  try {
    await execAsync("docker --version");
    return true;
  } catch {
    return false;
  }
}

async function setupLocalPostgres(): Promise<string> {
  log("\n🐳 Setting up local Postgres with Docker...", "blue");

  const dockerComposeContent = `services:
  postgres:
    image: postgres:16-alpine
    container_name: unified_app_postgres
    environment:
      POSTGRES_DB: better_auth
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    ports:
      - "5432:5432"
    volumes:
      - unified_app_postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d better_auth"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    container_name: unified_app_redis
    command: ["redis-server", "--appendonly", "yes"]
    ports:
      - "6379:6379"
    volumes:
      - unified_app_redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  unified_app_postgres_data:
  unified_app_redis_data:
`;

  const dockerComposePath = path.join(process.cwd(), "docker-compose.yml");

  // Check if docker-compose.yml already exists
  try {
    await fs.access(dockerComposePath);
    log("⚠️  docker-compose.yml already exists", "yellow");
    const overwrite = await question("   Overwrite it? (y/n): ");
    if (overwrite.toLowerCase() !== "y") {
      log("   Using existing docker-compose.yml", "blue");
      try {
        await execAsync("docker compose up -d");
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        log(
          `⚠️  Failed to start Docker services from existing compose file: ${errorMessage}`,
          "yellow"
        );
      }
      return LOCAL_DATABASE_URL;
    }
  } catch {
    // File doesn't exist, continue
  }

  await fs.writeFile(dockerComposePath, dockerComposeContent);
  log("✅ Created docker-compose.yml", "green");

  log("🚀 Starting Docker container...", "blue");
  try {
    await execAsync("docker compose up -d");
    log("✅ Docker container started", "green");
    log("   Waiting for Postgres to be ready...", "blue");

    // Wait for Postgres to be ready (simple retry logic)
    let retries = 30;
    while (retries > 0) {
      try {
        await execAsync("docker compose exec -T postgres pg_isready -U postgres");
        log("✅ Postgres is ready!", "green");
        break;
      } catch {
        retries -= 1;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    if (retries === 0) {
      log(
        "⚠️  Postgres may not be ready yet. You can check manually.",
        "yellow"
      );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`⚠️  Failed to start Docker container: ${errorMessage}`, "yellow");
    log("   You can start it manually with: docker compose up -d", "blue");
  }

  return LOCAL_DATABASE_URL;
}

async function getPostgresURL(): Promise<string> {
  log("\n💾 Database Configuration", "cyan");
  log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", "cyan");

  // Check if DATABASE_URL is already set
  if (process.env.DATABASE_URL) {
    log(
      `   Found DATABASE_URL in environment: ${process.env.DATABASE_URL.replace(PASSWORD_MASK_REGEX, ":****@")}`,
      "cyan"
    );
    const useEnv = await question("   Use this? (y/n): ");
    if (useEnv.toLowerCase() === "y") {
      return process.env.DATABASE_URL;
    }
  }

  const hasDocker = await checkDocker();
  let dbChoice: string;

  if (hasDocker) {
    dbChoice = await question(
      "\n   Setup options:\n   [L] Local Postgres with Docker (recommended for development)\n   [R] Remote Postgres URL\n   [S] Skip (use placeholder)\n   Enter choice (L/R/S): "
    );
  } else {
    log("   Docker not found. Skipping local setup option.", "yellow");
    dbChoice = await question(
      "\n   Setup options:\n   [R] Remote Postgres URL\n   [S] Skip (use placeholder)\n   Enter choice (R/S): "
    );
  }

  if (dbChoice.toLowerCase() === "l" && hasDocker) {
    return await setupLocalPostgres();
  }
  if (dbChoice.toLowerCase() === "r") {
    log("\n   You can find Postgres databases at:", "blue");
    log(
      "   - Vercel: https://vercel.com/marketplace?category=databases",
      "blue"
    );
    log("   - Supabase: https://supabase.com", "blue");
    log("   - Neon: https://neon.tech", "blue");
    const url = await question("\n   Enter your POSTGRES_URL: ");
    return (
      url.trim() || "postgresql://user:password@127.0.0.1:58432/better_auth"
    );
  }
  log(
    "   Using placeholder. Update DATABASE_URL in .env.local later.",
    "yellow"
  );
  return "postgresql://user:password@127.0.0.1:58432/better_auth";
}

async function testDatabaseConnection(databaseUrl: string): Promise<boolean> {
  // Try to import postgres if available (optional dependency check)
  try {
    const postgres = await import("postgres");
    const client = postgres.default(databaseUrl, { prepare: false, max: 1 });
    await client`SELECT 1`;
    await client.end();
    return true;
  } catch {
    // postgres package not available or connection failed
    return false;
  }
}

async function runMigration(databaseUrl: string): Promise<boolean> {
  try {
    const postgres = await import("postgres");
    const client = postgres.default(databaseUrl, { prepare: false });

    // Check if tables already exist
    const result = await client`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name = 'user'
    `;

    if (result.length > 0) {
      log("   Better Auth tables already exist, skipping migration", "yellow");
      await client.end();
      return true;
    }

    // Read migration file
    const migrationPath = path.join(
      process.cwd(),
      "drizzle/migrations/0000_sticky_boom_boom.sql"
    );

    try {
      const migrationSQL = await fs.readFile(migrationPath, "utf-8");

      // Execute migration SQL using postgres client
      // Split SQL into individual statements and execute each one
      const statements = migrationSQL
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.match(EMPTY_STATEMENT_REGEX));

      // Execute each statement using the postgres client
      // The postgres package supports executing raw SQL via the unsafe method
      for (const statement of statements) {
        // Execute raw SQL statement - unsafe method executes raw SQL strings
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (client as { unsafe: (sql: string) => Promise<unknown> }).unsafe(
          `${statement};`
        );
      }

      log("✅ Migration executed successfully", "green");
      await client.end();
      return true;
    } catch (fileError) {
      if (
        fileError &&
        typeof fileError === "object" &&
        "code" in fileError &&
        fileError.code === "ENOENT"
      ) {
        log(
          "   Migration file not found, Better Auth will create tables automatically",
          "yellow"
        );
        await client.end();
        return true;
      }
      throw fileError;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`⚠️  Could not run migration: ${errorMessage}`, "yellow");
    log(
      "   Better Auth will create tables automatically on first API call",
      "blue"
    );
    return false;
  }
}

function generateSecret(): string {
  return crypto.randomBytes(32).toString("base64");
}

async function createEnvFiles(
  envPath: string,
  envLocalPath: string,
  databaseUrl: string,
  secret: string
): Promise<void> {
  const envContent = `# Database
DATABASE_URL=${databaseUrl}

# Better Auth
BETTER_AUTH_SECRET=${secret}
BETTER_AUTH_URL=http://127.0.0.1:43103

# Email (optional - for password reset, verification, invitations, etc.)
# Uncomment and configure if you want email functionality
# RESEND_API_KEY=re_your_key
# BETTER_AUTH_EMAIL=noreply@yourdomain.com
# BETTER_AUTH_REPLY_TO=support@yourdomain.com

# Social Providers (optional)
# NEXT_PUBLIC_GOOGLE_CLIENT_ID=your_google_client_id
# GOOGLE_CLIENT_SECRET=your_google_client_secret
# GITHUB_CLIENT_ID=your_github_client_id
# GITHUB_CLIENT_SECRET=your_github_client_secret

# Stripe (optional)
# STRIPE_KEY=sk_test_your_key
# STRIPE_WEBHOOK_SECRET=whsec_your_secret
`;

  await fs.writeFile(envPath, envContent);
  log(`✅ Created ${envPath}`, "green");

  await fs.writeFile(envLocalPath, envContent);
  log(`✅ Created ${envLocalPath}`, "green");
}

async function main() {
  log("\n🚀 Better Auth Postgres Starter - Setup\n", "cyan");
  log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // Check Node.js version
  log("📋 Step 1: Checking prerequisites...", "blue");
  if (!checkNodeVersion()) {
    process.exit(1);
  }

  const envPath = path.join(process.cwd(), ".env");
  const envLocalPath = path.join(process.cwd(), ".env.local");

  // Check if .env or .env.local already exists
  let envExists = false;
  let envLocalExists = false;

  try {
    await fs.access(envPath);
    envExists = true;
  } catch {
    // File doesn't exist
  }

  try {
    await fs.access(envLocalPath);
    envLocalExists = true;
  } catch {
    // File doesn't exist
  }

  if (envExists || envLocalExists) {
    log("\n⚠️  Environment file(s) already exist:", "yellow");
    if (envExists) {
      log("   - .env", "yellow");
    }
    if (envLocalExists) {
      log("   - .env.local", "yellow");
    }
    const overwrite = await question("   Overwrite them? (y/n): ");
    if (overwrite.toLowerCase() !== "y") {
      log("   Skipping environment file creation.", "yellow");
      log(
        "   If you want to regenerate, delete .env and .env.local and run this script again.\n",
        "yellow"
      );
      process.exit(0);
    }
  }

  // Generate secret
  log("\n🔐 Step 2: Generating BETTER_AUTH_SECRET...", "blue");
  const secret = generateSecret();
  log("✅ Generated secure secret", "green");

  // Get database URL
  const databaseUrl = await getPostgresURL();

  // Test database connection if URL is provided and postgres package is available
  if (databaseUrl && !databaseUrl.includes("user:password")) {
    log("\n🔌 Step 3: Testing database connection...", "blue");
    const connected = await testDatabaseConnection(databaseUrl);
    if (connected) {
      log("✅ Database connection successful!", "green");

      // Run migration if connection successful
      log("\n📦 Step 4: Running database migration...", "blue");
      await runMigration(databaseUrl);
    } else {
      log(
        "⚠️  Could not test database connection (postgres package may not be installed)",
        "yellow"
      );
      log(
        "   Connection will be tested when you start the dev server.",
        "blue"
      );
    }
  }

  // Create .env and .env.local
  log("\n📝 Step 5: Creating .env and .env.local...", "blue");
  await createEnvFiles(envPath, envLocalPath, databaseUrl, secret);

  log("\n✅ Setup complete!", "green");

  // Next steps
  log("\n📚 Next Steps:\n", "cyan");
  log("1. Install dependencies:", "blue");
  log("   pnpm install", "cyan");
  log("2. Start the development server:", "blue");
  log("   pnpm dev", "cyan");
  log("3. Visit http://127.0.0.1:43103 to get started", "blue");
  if (databaseUrl && !databaseUrl.includes("user:password")) {
    log("   (Database tables have been created via migration)", "blue");
  } else {
    log(
      "   (Better Auth will create tables automatically on first API call)",
      "blue"
    );
  }

  if (databaseUrl.includes("docker")) {
    log("\n🐳 Docker Notes:", "cyan");
    log("   - Start: docker compose up -d", "blue");
    log("   - Stop: docker compose down", "blue");
    log("   - View logs: docker compose logs postgres", "blue");
  }

  log(
    "\n💡 Tip: Run 'pnpm generate-secret' anytime to generate a new secret",
    "yellow"
  );
  log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
}

main().catch((error) => {
  log(`\n❌ Setup failed: ${error.message}`, "red");
  if (error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});

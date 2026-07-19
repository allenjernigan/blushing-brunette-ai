# Production deployment

The production application uses PostgreSQL through Prisma. Shopify sessions,
shop settings, and finance records all use the same database connection.

## PostgreSQL setup

Provision a production PostgreSQL database before deploying the application.
For Google Cloud Run, Cloud SQL for PostgreSQL is the simplest managed option.
Create a dedicated database and application user, require encrypted connections,
and grant that user permission to create and alter tables during migrations.

Set `DATABASE_URL` to a standard Prisma PostgreSQL connection string:

```text
postgresql://USER:PASSWORD@HOST:5432/DATABASE?schema=public
```

If Cloud SQL is connected through its Unix socket, use the connection format
recommended by Google for the selected Cloud SQL connector. Do not commit the
connection string or database password.

### Local development

The repository includes a small Docker Compose PostgreSQL service. It uses
development-only credentials and stores data in a named Docker volume.

```sh
npm run db:up
cp .env.example .env
```

Set this local value in `.env`:

```text
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/blushing_brunette_ai?schema=public
```

Then initialize and run the app:

```sh
npm run prisma:generate
npm run prisma:migrate:dev
npm run dev
```

Stop PostgreSQL with `npm run db:down`. The named volume is retained. The old
ignored `prisma/dev.sqlite` file is also retained, but the application no longer
uses it. Do not copy local Shopify sessions into production; install the app on
the production store to create production sessions normally.

## Required environment variables

- `DATABASE_URL`: PostgreSQL connection string.
- `SHOPIFY_API_KEY`: production Shopify app client ID.
- `SHOPIFY_API_SECRET`: production Shopify app client secret.
- `SCOPES`: existing comma-separated Shopify scopes. This database migration does
  not change them.
- `SHOPIFY_APP_URL`: public HTTPS Cloud Run URL or mapped custom domain, without a
  trailing path.
- `OPENAI_API_KEY`: OpenAI API key used by AI features.
- `NODE_ENV`: set to `production`.
- `PORT`: supplied automatically by Cloud Run; do not hard-code it.

The app also supports `SHOP_CUSTOM_DOMAIN` when explicitly needed for Shopify
custom domains, but it is not required for a standard deployment.

## Secret handling

Keep production secrets in Google Secret Manager and expose them to the Cloud Run
service as environment variables. Grant only the runtime service account access
to those secrets. `.env` and `.env.*` are ignored by Git; `.env.example` contains
placeholders only and is intentionally tracked.

## Build, migration, and start commands

Install dependencies and build the image/application with:

```sh
npm ci
npm run build:production
```

Apply committed migrations to the production database with:

```sh
npm run prisma:migrate:deploy
```

Start the application with migrations applied first:

```sh
npm run start:production
```

The Docker image runs `build:production` while building and
`start:production` at container startup. `react-router-serve` reads Cloud Run's
`PORT` environment variable. Migration deployment is safe to rerun, but for
tightly controlled releases it can instead be run once as a Cloud Run job before
shifting traffic.

## Cloud Run overview

1. Create the PostgreSQL database and store all secrets in Secret Manager.
2. Build the container from the repository Dockerfile and push it to Artifact
   Registry.
3. Create or update the Cloud Run service, attach Cloud SQL if used, map the
   required secrets, and allow the service to receive HTTPS traffic.
4. Apply migrations before serving production traffic, either through the
   container startup command or a one-off Cloud Run job.
5. Confirm the health of the new revision before moving all traffic to it.

Do not run `prisma migrate dev` in production. It is only for creating and testing
migrations in a development database.

## Shopify application URLs

After the production Cloud Run URL is stable:

1. Set the Shopify app URL to the same HTTPS origin used by `SHOPIFY_APP_URL`.
2. Set the allowed redirection URL to
   `https://YOUR_APP_HOSTNAME/auth/callback`.
3. Update the matching production Shopify CLI configuration without changing
   scopes, then deploy the Shopify app configuration when ready.
4. Verify webhook delivery uses the production origin and valid TLS.

## Production-store installation

Install the production app from its Shopify installation link while signed into
the intended production store. Complete OAuth to create fresh offline and online
sessions in PostgreSQL. Verify the app shell, Settings, Finance filters, and one
read-only Shopify data request before enabling broader access.

Development-store session rows must not be imported into production because they
belong to a different environment and may contain development credentials.

## Rollback considerations

Cloud Run can shift traffic back to a previous application revision. Database
schema rollbacks require more care: Prisma migrations are forward-only in normal
operation, so prefer a corrective additive migration. Before a release containing
destructive schema changes, take a managed database backup and test restoration.

This PostgreSQL baseline creates a new production database and does not migrate
the old SQLite data. If importing non-session development data is ever required,
design and test a separate, explicit data migration rather than copying the SQLite
file or Shopify session tokens.

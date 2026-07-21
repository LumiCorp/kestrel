import { preparePackedConsumerFixture } from "../../tests/e2e/sdk-ecosystem/helpers.js";

const fixtureDir = preparePackedConsumerFixture();
process.stdout.write(`[validate:process] prepared packed consumer at ${fixtureDir}\n`);

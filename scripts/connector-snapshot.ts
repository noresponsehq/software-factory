import { parseArgs } from "node:util";
import { config, requireEnv, requireRepo } from "../app/config/index.js";
import { setupSnapshot } from "../app/connectors/setup.js";
import { gitData } from "../app/github/index.js";

const { values } = parseArgs({ options: { repo: { type: "string" } } });
const name = values.repo ?? Object.keys(config.repos)[0];
if (!name) throw new Error("No connector repository configured");
const repo = requireRepo(name, Number(requireEnv("FACTORY_GITHUB_INSTALLATION_ID")));
const sha = await gitData(repo).getRef(repo.config.baseBranch);
if (!sha) throw new Error("Cannot resolve snapshot revision");
process.stdout.write(`${JSON.stringify(await setupSnapshot(repo, sha))}\n`);

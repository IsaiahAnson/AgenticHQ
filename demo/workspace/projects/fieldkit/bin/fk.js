#!/usr/bin/env node
import { Command } from "commander";
import { sync } from "../src/commands/sync.js";
import { snap } from "../src/commands/snap.js";
import { doctor } from "../src/commands/doctor.js";

const program = new Command("fk").version("1.4.0");

program.command("sync <from> <to>")
  .option("--dry-run", "print the plan only")
  .option("--delete", "remove files that are gone from the source")
  .action(sync);

program.command("snap [path]")
  .option("--list", "list snapshots")
  .option("--restore <id>", "restore a snapshot")
  .action(snap);

program.command("doctor")
  .option("--json", "machine-readable output")
  .action(doctor);

program.parseAsync();

import { CodeBlock } from '../ui';
import type { View } from '../router';

interface LocalFeature { title: string; what: string; commands: Array<[string, string]> }

const LOCAL_FEATURES: Partial<Record<View, LocalFeature>> = {
  explorer: {
    title: 'Tests',
    what: 'Test specs live in your repository and run on your machine with Playwright. The hosted service does not run spec code: it runs declarative workflows, which you start from the Runs page.',
    commands: [
      ['Run your specs locally', 'airlock test'],
      ['Run a workflow on Airlock Cloud', 'airlock test --cloud --workflow workflow.json'],
    ],
  },
  recorder: {
    title: 'Recorder',
    what: 'The recorder opens a real browser window and saves your clicks, typing and key presses as a trace. Compile the trace into a Playwright spec afterwards.',
    commands: [
      ['Record a trace', 'airlock explore https://staging.example.com'],
      ['Compile a trace into a spec', 'airlock compile <tracePath>'],
    ],
  },
  healing: {
    title: 'Self-healing',
    what: 'When a locator stops matching, the local runner can look for a safer one and log what it changed. Healing happens inside your local test run, not in hosted runs.',
    commands: [
      ['Run specs with healing on', 'airlock test'],
      ['Inspect logged locator patches', 'airlock dataset'],
    ],
  },
  checkpoints: {
    title: 'Checkpoints',
    what: 'A checkpoint saves browser state part-way through a local run. Forking restores it into parallel browser contexts and tries one input value in each.',
    commands: [
      ['Fork a checkpoint', 'airlock fork <checkpointName> --values "SAVE10,SAVE20" --input "#coupon" --action "#apply"'],
    ],
  },
  policy: {
    title: 'Request policy',
    what: 'The request policy decides which hosts, methods and paths a test may reach. Hosted runs apply the allowed hosts, methods and blocked paths you send as phantomConfig; the full policy files are managed locally.',
    commands: [
      ['Create configuration and sample policies', 'airlock init'],
      ['Run a workflow locally with the policy', 'airlock run'],
    ],
  },
  timewarp: {
    title: 'Time warp',
    what: "Time warp moves the browser's clock forward so you can test expiry, trials and scheduled behaviour without waiting. It works in the local browser.",
    commands: [['Fast-forward the virtual clock', 'airlock warp "+14 days"']],
  },
  fixtures: {
    title: 'Fixtures',
    what: 'Fixtures pin recorded API responses so a test does not change when a real service does. They are part of the local runner. The hosted service has no fixture store.',
    commands: [['Run specs locally', 'airlock test']],
  },
  chaos: {
    title: 'Chaos report',
    what: 'The chaos check triggers one mutation, such as a checkout click, and reports whether the request carries an idempotency key. It runs against a URL from your machine.',
    commands: [['Check a mutation', 'airlock chaos https://staging.example.com --action "#pay"']],
  },
  capsules: {
    title: 'Bug capsules',
    what: 'A bug capsule is a saved browser state. Teleporting a capsule writes a Playwright spec that reproduces the bug.',
    commands: [['Write a repro spec from a capsule', 'airlock teleport <capsulePath> --out repro.spec.ts']],
  },
};

export default function LabPreview({ view }: { view: View }) {
  const feature = LOCAL_FEATURES[view];
  if (!feature) return <main className="lv-main" id={'live-' + view}><p className="lv-muted">Nothing to show here.</p></main>;
  return (
    <main className="lv-main" id={'live-' + view}>
      <div className="lv-head">
        <div className="lv-head-text">
          <div className="lv-title-row">
            <h1 className="lv-title" tabIndex={-1}>{feature.title}</h1>
            <span className="lv-badge-preview">Local CLI</span>
          </div>
          <p className="lv-sub">{feature.what}</p>
        </div>
      </div>
      <section className="lv-card" aria-labelledby={'local-' + view}>
        <h2 id={'local-' + view} className="lv-card-title">Runs on your machine</h2>
        <p className="lv-muted">This feature is part of the local CLI. The hosted console does not run it or store its results yet, so there is no cloud data to show here. The commands below run on your machine.</p>
        <p className="lv-small"><a className="lv-link" href="https://github.com/katesaikishore/AirlockQA/blob/main/docs/HOW-TO-USE.md" target="_blank" rel="noreferrer">Read the local guide</a></p>
        <div className="lv-stack">
          {feature.commands.map(([label, command]) => (
            <div key={command}>
              <p className="lv-small lv-muted">{label}</p>
              <CodeBlock text={command} />
            </div>
          ))}
        </div>
        <p className="lv-muted lv-small">To use Airlock Cloud instead, <a href="#runs/new" className="lv-link">start a cloud run</a>.</p>
      </section>
    </main>
  );
}

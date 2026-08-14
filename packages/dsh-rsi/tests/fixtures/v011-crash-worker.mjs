import { appendFile } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { join } from 'node:path'
import { recoverV011OutcomeDerivation, recoverV011ProposalPublication } from '../../lib/index.js'

const [root, action, crash] = process.argv.slice(2)
if (!root || !action) throw new Error('usage: worker <root> <proposal|outcome> <crash|resume>')

if (action === 'proposal') {
  const proposalId = 'p_11111111111111111111111111111111'
  const result = await recoverV011ProposalPublication({
    path: join(root, 'proposal.json'),
    expectedProposalId: proposalId,
    async produce() {
      await appendFile(join(root, 'model-calls.txt'), 'call\n')
      return Buffer.from(JSON.stringify({ proposalId }) + '\n')
    },
    afterDurablePublish() {
      if (crash === 'crash') process.kill(process.pid, 'SIGKILL')
    },
  })
  process.stdout.write(JSON.stringify(result) + '\n')
} else if (action === 'outcome') {
  const result = await recoverV011OutcomeDerivation({
    path: join(root, 'outcome.json'),
    proposalDigest: `sha256:${'1'.repeat(64)}`,
    hypothesis: 'One bounded retry changes the target observable after a transient failure.',
    candidateDigest: `sha256:${'2'.repeat(64)}`,
    targetClusterSlug: 'transient-tool-stop',
    targetTaskHandle: 'opaque-1',
    trials: [
      { ref: `sha256:${'3'.repeat(64)}`, role: 'target-baseline', status: 'fail', reward: 0 },
      { ref: `sha256:${'4'.repeat(64)}`, role: 'target-child', status: 'pass', reward: 1 },
    ],
    afterDurablePublish() {
      if (crash === 'crash') process.kill(process.pid, 'SIGKILL')
    },
  })
  process.stdout.write(JSON.stringify(result) + '\n')
} else {
  throw new Error(`unknown action ${action}`)
}

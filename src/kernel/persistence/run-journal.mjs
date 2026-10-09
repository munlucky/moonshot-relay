// Audit facts share the authority transaction. They are never replayed to
// reconstruct Work, Trust, or Knowledge, and contain no prompts/transcripts.
export const runJournalSchema = () => {
  const fact = (kind, subject = 'NULL') => `
    INSERT INTO run_journal(run_id, kind, subject_id, contract_revision, mutation_revision, created_at)
    SELECT NEW.run_id, '${kind}', ${subject}, contract_revision, mutation_revision,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM runs WHERE run_id=NEW.run_id;`;
  return `
    CREATE TABLE IF NOT EXISTS run_journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      subject_id TEXT,
      contract_revision INTEGER NOT NULL,
      mutation_revision INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_run_journal_run ON run_journal(run_id, id);
    CREATE TRIGGER IF NOT EXISTS run_journal_no_update BEFORE UPDATE ON run_journal
    BEGIN SELECT RAISE(ABORT, 'run_journal_append_only'); END;
    CREATE TRIGGER IF NOT EXISTS run_journal_no_delete BEFORE DELETE ON run_journal
    BEGIN SELECT RAISE(ABORT, 'run_journal_append_only'); END;
    CREATE TRIGGER IF NOT EXISTS journal_task_created AFTER INSERT ON runs
    BEGIN ${fact('task-created')} END;
    CREATE TRIGGER IF NOT EXISTS journal_contract_revised AFTER UPDATE OF contract_revision ON runs
    WHEN NEW.contract_revision != OLD.contract_revision
    BEGIN ${fact('contract-revised')} END;
    CREATE TRIGGER IF NOT EXISTS journal_work_started AFTER UPDATE OF state ON run_steps
    WHEN NEW.state='running' AND OLD.state != NEW.state
    BEGIN ${fact('work-started', 'NEW.step_id')} END;
    CREATE TRIGGER IF NOT EXISTS journal_work_completed AFTER UPDATE OF state ON run_steps
    WHEN NEW.state='passed' AND OLD.state != NEW.state
    BEGIN ${fact('work-completed', 'NEW.step_id')} END;
    CREATE TRIGGER IF NOT EXISTS journal_evidence_produced AFTER INSERT ON verifications
    BEGIN ${fact('evidence-produced', 'NEW.obligation_id')} END;
    CREATE TRIGGER IF NOT EXISTS journal_evidence_revised AFTER UPDATE ON verifications
    WHEN NEW.evidence_digest IS NOT OLD.evidence_digest OR NEW.status IS NOT OLD.status
    BEGIN ${fact('evidence-produced', 'NEW.obligation_id')} END;
    CREATE TRIGGER IF NOT EXISTS journal_review_produced AFTER INSERT ON review_receipts
    BEGIN ${fact('review-produced', 'NEW.obligation_id')} END;
    CREATE TRIGGER IF NOT EXISTS journal_completion_decided AFTER INSERT ON completion_decisions
    BEGIN ${fact('completion-decided', 'NEW.decision')} END;
    CREATE TRIGGER IF NOT EXISTS journal_completion_revised AFTER UPDATE ON completion_decisions
    WHEN NEW.evidence_digest IS NOT OLD.evidence_digest OR NEW.decision IS NOT OLD.decision
    BEGIN ${fact('completion-decided', 'NEW.decision')} END;
    CREATE TRIGGER IF NOT EXISTS journal_knowledge_committed AFTER INSERT ON knowledge_commit_receipts
    WHEN NEW.status='committed'
    BEGIN ${fact('knowledge-committed', 'CAST(NEW.revision_after AS TEXT)')} END;
    CREATE TRIGGER IF NOT EXISTS journal_knowledge_revised AFTER UPDATE ON knowledge_commit_receipts
    WHEN NEW.status='committed' AND (NEW.revision_after IS NOT OLD.revision_after OR OLD.status != NEW.status)
    BEGIN ${fact('knowledge-committed', 'CAST(NEW.revision_after AS TEXT)')} END;
  `;
};

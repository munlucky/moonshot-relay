----------------------------- MODULE Fencing -----------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Mutant, Reissue, FailRecovery
VARIABLE s
vars == <<s>>

TimePoints == {0, 1, 59, 60, 61, 119, 120, 121, 122,
               179, 180, 181, 239, 240, 241, 242}
TTL == 120
LiveId == IF s.effects = 0 THEN "base"
          ELSE IF s.effects = 1 THEN "effectA" ELSE "drift"
HeldA == s.owner = "A" /\ s.epoch = s.tokenA /\ s.now < s.expiry
TokenOK == s.owner = "A" /\ s.now < s.expiry
           /\ (s.epoch = s.tokenA \/ Mutant = "token")
BaseOK == (s.rev = 0 /\ s.identity = "base") \/ Mutant = "cas"
PreTokenOK == TokenOK \/ Mutant = "pre"
PostOK == (TokenOK \/ Mutant = "post") /\ BaseOK /\ LiveId = "effectA"
Duration == IF s.aExpiry <= s.now + 1 THEN 0
            ELSE IF s.aExpiry - s.now - 1 < 60
                 THEN s.aExpiry - s.now - 1 ELSE 60

Init == s = [now |-> 0, owner |-> "none", epoch |-> 0, expiry |-> 0,
             tokenA |-> 0, aExpiry |-> 0, pc |-> "idle", duration |-> 0,
             deadline |-> 0, effects |-> 0, requests |-> 0, rev |-> 0,
             identity |-> "base", provenance |-> FALSE, accepted |-> FALSE,
             finalValid |-> FALSE, staleEffect |-> FALSE, overlap |-> FALSE,
             attempted |-> FALSE, blocked |-> FALSE, handled |-> FALSE,
             settled |-> FALSE, releaseDone |-> FALSE, restarted |-> FALSE,
             expiredCommit |-> FALSE]

Advance == \E t \in TimePoints :
             /\ t > s.now
             /\ s' = [s EXCEPT !.now = t]

AcquireA == /\ s.pc = "idle" /\ s.epoch = 0
            /\ s' = [s EXCEPT !.owner = "A", !.epoch = 1,
                     !.expiry = s.now + TTL, !.aExpiry = s.now + TTL,
                     !.tokenA = 1, !.pc = "acquired"]

AcquireB == /\ s.epoch = 1
            /\ (Reissue \/ s.owner = "none" \/ s.now >= s.expiry
                \/ Mutant = "overlap")
            /\ s' = [s EXCEPT
                     !.owner = IF Reissue THEN "A" ELSE "B",
                     !.epoch = 2, !.expiry = s.now + TTL,
                     !.overlap = s.overlap \/
                       (~Reissue /\ s.owner = "A" /\ s.now < s.expiry)]

PatchCheck == /\ s.pc = "acquired"
              /\ s' = [s EXCEPT !.pc = "checked"]

RenewA == /\ s.pc = "checked" /\ HeldA
          /\ s' = [s EXCEPT !.expiry = s.now + TTL,
                   !.aExpiry = s.now + TTL, !.pc = "renewed"]
RenewRejected == /\ s.pc = "checked" /\ ~HeldA
                 /\ s' = [s EXCEPT !.pc = "failed"]

PreApplyCAS == /\ s.pc = "renewed"
               /\ PreTokenOK /\ BaseOK /\ LiveId = "base"
               /\ s' = [s EXCEPT !.pc = "prevalidated"]
PreRejected == /\ s.pc = "renewed"
               /\ ~(PreTokenOK /\ BaseOK /\ LiveId = "base")
               /\ s' = [s EXCEPT !.pc = "failed"]

ComputeDeadline == /\ s.pc = "prevalidated"
                   /\ s' = [s EXCEPT !.attempted = TRUE,
                            !.duration = Duration,
                            !.pc = IF Duration > 0 THEN "ready" ELSE "failed"]
StartApply == /\ s.pc = "ready"
              /\ s' = [s EXCEPT !.pc = "running",
                       !.deadline = s.now + s.duration]
ApplyEffect == /\ s.pc \in {"running", "timeout"} /\ s.effects = 0
               /\ s' = [s EXCEPT !.effects = 1, !.staleEffect = ~HeldA]
ApplySuccess == /\ s.pc = "running" /\ s.effects = 1
                /\ s' = [s EXCEPT !.pc = "applied"]
ApplyFailure == /\ s.pc \in {"running", "timeout"}
                /\ s' = [s EXCEPT !.pc = "failed"]
TimeoutRequest == /\ s.pc = "running" /\ s.now >= s.deadline
                  /\ s' = [s EXCEPT !.pc = "timeout"]
Terminate == /\ s.pc = "timeout"
             /\ s' = [s EXCEPT !.pc = "failed"]

PostApplyCAS == /\ s.pc = "applied" /\ s.requests < 2
                /\ s' = [s EXCEPT !.requests = @ + 1,
                         !.pc = IF PostOK THEN "postvalidated" ELSE "failed"]

CommitRevision == /\ s.pc = "postvalidated" /\ s.rev < 2
                  /\ BaseOK /\ (s.identity # LiveId \/ Mutant = "cas")
                  /\ s' = [s EXCEPT !.rev = @ + 1, !.identity = LiveId,
                           !.provenance = TRUE, !.pc = "committed",
                           !.expiredCommit = s.expiredCommit \/ ~HeldA]
CommitRejected == /\ s.pc = "postvalidated"
                  /\ ~(BaseOK /\ (s.identity # LiveId \/ Mutant = "cas"))
                  /\ s' = [s EXCEPT !.pc = "failed"]

FinalCheck == /\ s.pc = "committed"
              /\ TokenOK /\ s.rev = 1 /\ s.identity = LiveId
              /\ s' = [s EXCEPT !.pc = "finalvalidated", !.finalValid = HeldA]
FinalRejected == /\ s.pc = "committed"
                 /\ ~(TokenOK /\ s.rev = 1 /\ s.identity = LiveId)
                 /\ s' = [s EXCEPT !.pc = "failed"]
ReturnApplied == /\ s.pc = "finalvalidated"
                 /\ s' = [s EXCEPT !.accepted = TRUE, !.pc = "accepted"]
DuplicateReceipt == /\ s.pc = "accepted" /\ s.requests < 2
                    /\ s' = [s EXCEPT !.pc = "applied"]

ReleaseSuccess == /\ s.pc = "accepted" /\ ~s.releaseDone
                  /\ s.owner = "A" /\ s.epoch = s.tokenA
                  /\ s' = [s EXCEPT !.releaseDone = TRUE,
                           !.owner = "none", !.pc = "deliveryReady"]
ReleaseFailure == /\ s.pc = "accepted" /\ ~s.releaseDone
                  /\ s' = [s EXCEPT !.releaseDone = TRUE, !.pc = "failed"]
HandleFailure == /\ s.pc = "failed"
                 /\ \E success \in BOOLEAN :
                    /\ (success \/ FailRecovery \/ ~s.attempted)
                    /\ s' = [s EXCEPT !.handled = TRUE,
                             !.blocked = s.blocked \/ (s.attempted /\ success),
                             !.pc = "handled"]

Crash == /\ s.pc \in {"ready", "running", "timeout", "applied",
                      "postvalidated", "committed", "finalvalidated", "accepted"}
         /\ s' = [s EXCEPT !.pc = "crashed"]
RestartReconcile == /\ s.pc = "crashed" /\ ~s.restarted
                    /\ s' = [s EXCEPT !.restarted = TRUE,
                             !.blocked = s.blocked \/ s.effects > 0 \/ s.provenance,
                             !.pc = IF s.effects > 0 \/ s.provenance
                                    THEN "restartBlocked" ELSE "restartClean"]
ExternalDrift == /\ s.pc = "deliveryReady" /\ s.effects = 1
                 /\ s' = [s EXCEPT !.effects = 2]
SettlementOK == s.accepted /\ ~s.blocked /\ s.provenance
                /\ s.rev = 1 /\ s.identity = LiveId /\ LiveId = "effectA"
Settle == /\ ((s.pc = "deliveryReady" /\ SettlementOK)
              \/ (Mutant = "settlement" /\ s.pc \in {"handled", "deliveryReady"}))
          /\ s' = [s EXCEPT !.settled = TRUE, !.pc = "settled"]

Next == Advance \/ AcquireA \/ AcquireB \/ PatchCheck \/ RenewA \/ RenewRejected
        \/ PreApplyCAS \/ PreRejected \/ ComputeDeadline \/ StartApply
        \/ ApplyEffect \/ ApplySuccess \/ ApplyFailure \/ TimeoutRequest
        \/ Terminate \/ PostApplyCAS \/ CommitRevision \/ CommitRejected
        \/ FinalCheck \/ FinalRejected \/ ReturnApplied \/ DuplicateReceipt
        \/ ReleaseSuccess \/ ReleaseFailure \/ HandleFailure \/ Crash
        \/ RestartReconcile \/ ExternalDrift \/ Settle

TypeOK == /\ s.now \in TimePoints /\ s.epoch \in 0..2 /\ s.rev \in 0..2
          /\ s.effects \in 0..2 /\ s.requests \in 0..2
          /\ s.expiry \in 0..362 /\ s.deadline \in 0..302
Safety1 == ~s.overlap
Safety2 == s.rev <= 1
Safety3 == ~s.accepted \/ s.finalValid
Safety4A == ~s.staleEffect
Safety4BApproval == ~s.accepted \/ ~s.staleEffect
Safety4BSettlement == ~s.settled \/ SettlementOK
Recovery1Mark == ~(s.handled /\ s.attempted) \/ s.blocked
Recovery1Block == ~(s.handled /\ s.settled)

NotNormalSettlement == ~s.settled
NotDuplicateRequest == s.requests < 2
NotExpiredCommit == ~s.expiredCommit
NotReconciledCrash == s.pc # "restartBlocked"
NotPendingTimeout == s.pc # "timeout"
NotStaleReacquire == ~(s.staleEffect /\ s.epoch = 2 /\ s.owner = "B")
NotExpiredReturn == ~(s.accepted /\ ~HeldA /\ ~s.releaseDone)
=============================================================================

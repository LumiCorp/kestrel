# Converge prepared cleanup across retry and lifecycle

## Failed behavior

The durable cleanup contract still has terminal convergence gaps. A transient
release can succeed when its pending effect resumes, but execution then enters
an undefined next step and Web requeues forever. User Stop, thread archive, or
ordinary pg-boss retry exhaustion can terminalize or make the cleanup
unclaimable before exact release is durably proven.

## Affected work

[Make prepared approval cleanup durable](06e-make-prepared-cleanup-durable.md),
commit `899651d7a`, especially the Acter cleanup transition, execution-engine
pending-effect resume, `apps/web/lib/turns/process-runtime.ts`, durable stop and
maintenance claim paths, and turn-job exhaustion handling.

## Repair requirements

Make successful resumed cleanup effects terminalize immediately without a
model, tool, or ordinary scheduler step. Canonical cleanup must survive Stop,
archive, and ordinary job-attempt exhaustion until the exact release effect is
durably DONE; do not report a terminal turn while the cleanup interaction is
still processing or the source may remain retained. Permit archived-thread
maintenance only for the exact canonical binding. Give cleanup reconciliation
an explicit durable retry path independent of ordinary job exhaustion, without
making ordinary turns or effects unbounded.

## Done when

- A release that fails once then succeeds converges on one failed interaction
  and failed turn, with one exact release and no scheduler/model/tool step.
- Stop before or during cleanup preserves/requeues cleanup until release is
  proven, then records the requested terminal truth without stranding state.
- Archive between scheduling and claim does not block the exact maintenance
  cleanup; unrelated archived-thread claims remain forbidden.
- The last ordinary job attempt cannot terminalize a requeued cleanup without
  durable release evidence.
- Full runner/Web/PostgreSQL fault tests cover all four lifecycle paths.

## Depends on

[Make prepared approval cleanup durable](06e-make-prepared-cleanup-durable.md).

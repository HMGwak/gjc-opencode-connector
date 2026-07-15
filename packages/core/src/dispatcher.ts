import type { Command } from "./types";
import type { CoreDatabase } from "./database";

export type CorrelationLookup = "confirmed" | "not-found" | "unknown";

/**
 * A remote command endpoint. A correlation-capable endpoint must use the supplied
 * correlation id as its idempotency key and retain it for restart reconciliation.
 */
export interface DurableCommandRemote<T> {
  readonly supportsCorrelation: boolean;
  dispatch(input: { readonly command: Command<T>; readonly correlationId: string }): Promise<void>;
  lookup?(correlationId: string): Promise<CorrelationLookup>;
}

export interface DurableCommandDispatcherOptions<T> {
  readonly database: CoreDatabase;
  readonly remote: DurableCommandRemote<T>;
  readonly correlationId?: () => string;
  readonly leaseMs?: number;
  readonly eventType?: string;
  readonly unknownEventType?: string;
}

const defaultCorrelationId = (): string => crypto.randomUUID();

/**
 * Persists every boundary around an ambiguous remote mutation.  A command that
 * was merely accepted has not been sent and may be dispatched.  Once marked
 * dispatching it is never blindly retried: correlation-capable remotes are
 * reconciled first; all other ambiguous calls become unknown.
 */
export class DurableCommandDispatcher<T> {
  private readonly leaseMs: number;
  private readonly eventType: string;
  private readonly unknownEventType: string;

  constructor(private readonly options: DurableCommandDispatcherOptions<T>) {
    this.leaseMs = options.leaseMs ?? 30_000;
    this.eventType = options.eventType ?? "command.remote-confirmed";
    this.unknownEventType = options.unknownEventType ?? "command.unknown";
  }

  async dispatch(id: string): Promise<Command<T>> {
    const current = this.options.database.getCommand<T>(id);
    if (!current) throw new Error("Command does not exist");
    if (current.state !== "accepted") return this.recoverCommand(current);
    const correlationId = current.correlationId ?? (this.options.correlationId ?? defaultCorrelationId)();
    const claimed = this.options.database.claimCommand<T>({ id, correlationId, leaseExpiresAt: new Date(Date.now() + this.leaseMs).toISOString() });
    if (!claimed) {
      const [recovered] = await this.recover(id);
      if (!recovered) throw new Error("Command does not exist");
      return recovered;
    }
    return this.send(claimed);
  }

  async recover(id?: string): Promise<Command<T>[]> {
    const commands = id ? [this.options.database.getCommand<T>(id)].filter((command): command is Command<T> => command !== null) : this.options.database.listCommandsForRecovery<T>();
    return Promise.all(commands.map((command) => this.recoverCommand(command)));
  }

  private async recoverCommand(command: Command<T>): Promise<Command<T>> {
    if (command.state === "accepted") return this.dispatch(command.id);
    if (command.state === "remote-confirmed" || command.state === "applied" || command.state === "unknown" || command.state === "failed") return command;
    if (!this.options.remote.supportsCorrelation || !command.correlationId || !this.options.remote.lookup) return this.unknown(command.id);
    let result: CorrelationLookup;
    try {
      result = await this.options.remote.lookup(command.correlationId);
    } catch {
      return this.unknown(command.id);
    }
    if (result === "confirmed") return this.confirm(command.id);
    if (result === "unknown") return this.unknown(command.id);
    const claimed = this.options.database.renewCommandLease<T>({ id: command.id, correlationId: command.correlationId, leaseExpiresAt: new Date(Date.now() + this.leaseMs).toISOString() });
    return claimed ? this.send(claimed) : this.options.database.getCommand<T>(command.id)!;
  }

  private async send(command: Command<T>): Promise<Command<T>> {
    const correlationId = command.correlationId;
    if (!correlationId) return this.unknown(command.id);
    try {
      await this.options.remote.dispatch({ command, correlationId });
    } catch {
      return this.unknown(command.id);
    }
    return this.confirm(command.id);
  }

  private confirm(id: string): Command<T> {
    return this.options.database.confirmCommand<T>({ id, eventType: this.eventType, eventPayload: { commandId: id } });
  }

  private unknown(id: string): Command<T> {
    return this.options.database.markCommandUnknown<T>({ id, eventType: this.unknownEventType, eventPayload: { commandId: id } });
  }
}

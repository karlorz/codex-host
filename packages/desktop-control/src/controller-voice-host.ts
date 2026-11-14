import path from "node:path";
import {
  REALTIME_CALL_METHOD,
  VOICE_GATEWAY_STATUS_METHOD,
  VOICE_SETTINGS_METHOD,
} from "@codexhost/shared-contracts";
import { HostClientChannel, discoverHostClientChannel } from "./host-client-channel.js";
import type { RendererVoiceHostOwner, VoiceHostExecution } from "./renderer-voice-host-binding.js";

export class ControllerVoiceHost implements RendererVoiceHostOwner {
  readonly owner = crypto.randomUUID();
  generation = 1;
  readonly #listeners = new Set<() => void>();
  constructor(private readonly channel: HostClientChannel) {
    this.generation = Math.max(1, channel.channelGeneration);
    channel.subscribe((update) => {
      if (update.type !== "connection") return;
      const next = Math.max(1, channel.channelGeneration);
      if (next === this.generation) return;
      this.generation = next;
      for (const listener of this.#listeners) listener();
    });
  }

  onGenerationChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  bindExecution(): VoiceHostExecution {
    return this.channel.bindVoiceExecution();
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === VOICE_SETTINGS_METHOD) return this.channel.requestVoiceSettings(params);
    if (method === VOICE_GATEWAY_STATUS_METHOD) return this.channel.requestVoiceGatewayStatus();
    if (method === REALTIME_CALL_METHOD) return this.channel.requestRealtimeCall(params);
    return Promise.reject(
      Object.assign(new Error("Voice method is not available"), { code: -32601 }),
    );
  }

  close(): void {
    this.#listeners.clear();
    this.channel.close();
  }
}

export async function connectControllerVoiceHost(
  dataDirectory: string,
): Promise<ControllerVoiceHost | undefined> {
  const directory = path.join(dataDirectory, "client-hosts");
  const descriptor = await discoverHostClientChannel(directory);
  if (!descriptor) return;
  const channel = new HostClientChannel(directory, descriptor);
  try {
    await channel.start();
    return new ControllerVoiceHost(channel);
  } catch {
    channel.close();
    return;
  }
}

const DATA_FLOW_ACK_KEY = "external-regulation-agent:third-party-data-flow-ack";

let inMemoryAcknowledged = false;

const sessionStore = (): Storage | null => {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
};

export const modelDataFlowConsent = {
  needsAcknowledgement(): boolean {
    try {
      if (sessionStore()?.getItem(DATA_FLOW_ACK_KEY) === "acknowledged") {
        inMemoryAcknowledged = true;
      }
    } catch {
      // Fall back to the in-memory flag when session storage is restricted.
    }
    return !inMemoryAcknowledged;
  },

  acknowledge(): void {
    inMemoryAcknowledged = true;
    try {
      sessionStore()?.setItem(DATA_FLOW_ACK_KEY, "acknowledged");
    } catch {
      // The in-memory acknowledgement remains valid for this page session.
    }
  },

  clear(): void {
    inMemoryAcknowledged = false;
    try {
      sessionStore()?.removeItem(DATA_FLOW_ACK_KEY);
    } catch {
      // Clearing memory is sufficient when session storage is restricted.
    }
  },
};

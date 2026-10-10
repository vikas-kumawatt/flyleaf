// The device half of the neutral age gate (D-07b-1). Once an under-13 date is
// entered at signup or confirmation on this device, later dates are refused
// too (applyAgeGate). The server keeps its own record per account; this one
// covers signup, where there is no account yet.

import * as SecureStore from 'expo-secure-store';

const AGE_GATE_KEY = 'age_gate_v1';

export async function isDeviceAgeGated(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(AGE_GATE_KEY)) === '1';
  } catch {
    return false;
  }
}

export async function recordDeviceAgeGate(): Promise<void> {
  try {
    await SecureStore.setItemAsync(AGE_GATE_KEY, '1');
  } catch {
    // The server's record still holds for an account; signup retries on a
    // device without storage are not stoppable here.
  }
}

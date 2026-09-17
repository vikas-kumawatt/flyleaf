// Contextual Action Gate (PRD §4.2, surprises.md §133, tasks.md SL-31).
//
// "Gate at the action, never at the door.
// The prompt appears the moment a guest taps Log, Rate, Follow or Like,
// and it says what they were trying to do: 'Sign up to log Piranesi' — not a generic wall.
// One tap to dismiss: A guest who declines returns exactly where they were, with nothing lost.
// Offers sign-in as well as sign-up."

import React, { createContext, useContext, useState, useCallback } from 'react';
import {
  View,
  Modal,
  Pressable,
  StyleSheet,
  TouchableWithoutFeedback,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Button, Txt } from './components';
import { space, radius, useTheme } from './tokens';

export interface ActionGateOptions {
  title: string;
  subtitle?: string;
  onDismiss?: () => void;
}

interface ActionGateContextType {
  promptAuth: (options: ActionGateOptions) => void;
  dismiss: () => void;
}

const ActionGateContext = createContext<ActionGateContextType | null>(null);

export function ActionGateProvider({ children }: { children: React.ReactNode }) {
  const [gateOptions, setGateOptions] = useState<ActionGateOptions | null>(null);
  const router = useRouter();
  const c = useTheme();

  const promptAuth = useCallback((options: ActionGateOptions) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setGateOptions(options);
  }, []);

  const dismiss = useCallback(() => {
    if (gateOptions?.onDismiss) {
      gateOptions.onDismiss();
    }
    setGateOptions(null);
  }, [gateOptions]);

  const handleSignUp = () => {
    dismiss();
    router.push('/auth');
  };

  const handleSignIn = () => {
    dismiss();
    router.push('/auth');
  };

  return (
    <ActionGateContext.Provider value={{ promptAuth, dismiss }}>
      {children}

      <Modal
        visible={!!gateOptions}
        transparent
        animationType="fade"
        onRequestClose={dismiss}
      >
        <TouchableWithoutFeedback onPress={dismiss}>
          <View style={styles.overlay}>
            <TouchableWithoutFeedback onPress={(e) => e.stopPropagation()}>
              <View
                style={[
                  styles.sheetContent,
                  {
                    backgroundColor: c.surface,
                    borderColor: c.line,
                  },
                ]}
                accessibilityRole="alert"
                accessibilityLiveRegion="assertive"
              >
                {/* Visual drag handle */}
                <View style={[styles.dragHandle, { backgroundColor: c.line }]} />

                <View style={{ gap: space[2], marginTop: space[2] }}>
                  <Txt variant="displayM" style={{ textAlign: 'center' }}>
                    {gateOptions?.title ?? 'Sign up for Flyleaf'}
                  </Txt>
                  <Txt
                    variant="body"
                    color="muted"
                    style={{ textAlign: 'center', lineHeight: 22 }}
                  >
                    {gateOptions?.subtitle ??
                      'Keep track of your reading, log daily pages, and carry your library across devices.'}
                  </Txt>
                </View>

                {/* Actions stack */}
                <View style={{ gap: space[3], marginTop: space[4] }}>
                  <Button
                    label="Create an account"
                    variant="primary"
                    onPress={handleSignUp}
                  />
                  <Button
                    label="Sign in"
                    variant="secondary"
                    onPress={handleSignIn}
                  />
                  <Button
                    label="Not now"
                    variant="tertiary"
                    onPress={dismiss}
                  />
                </View>
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
    </ActionGateContext.Provider>
  );
}

export function useActionGate() {
  const ctx = useContext(ActionGateContext);
  if (!ctx) {
    throw new Error('useActionGate must be used inside ActionGateProvider');
  }
  return ctx;
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    justifyContent: 'flex-end',
  },
  sheetContent: {
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderTopWidth: 1,
    paddingHorizontal: space[4],
    paddingTop: space[3],
    paddingBottom: space[8],
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -4 },
        shadowOpacity: 0.15,
        shadowRadius: 12,
      },
      android: {
        elevation: 16,
      },
    }),
  },
  dragHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: space[3],
  },
});

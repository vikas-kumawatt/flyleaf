// Global React Error Boundary (SL-82, PRD §28.2).
//
// Intercepts component render exceptions, reports them to Sentry, and presents
// a dignified recovery interface respecting the Flyleaf design system.

import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { StyleSheet, View, Platform } from 'react-native';
import { captureMobileException } from '../lib/sentry';
import { Txt, Button } from './components';
import { space, radius, useTheme } from './tokens';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    void captureMobileException(error, {
      componentStack: info.componentStack || undefined,
    });
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return <Fallback message={__DEV__ ? this.state.error?.message : undefined} onReset={this.handleReset} />;
    }

    return this.props.children;
  }
}

// A function component so it can read the theme. Outside the ThemeProvider
// useTheme falls back to the light palette, so every colour still comes from
// tokens and text keeps its contrast.
function Fallback({ message, onReset }: { message?: string; onReset: () => void }) {
  const c = useTheme();
  return (
    <View style={[styles.container, { backgroundColor: c.ground }]}>
      <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.line }]}>
        <Txt variant="displayM" style={styles.center}>
          Something went wrong
        </Txt>
        <Txt variant="body" color="ink2" style={styles.center}>
          This screen hit an error. Your reading log and offline changes are safe.
        </Txt>

        {message ? (
          <View style={[styles.devBox, { backgroundColor: c.surface2, borderColor: c.line }]}>
            <Txt variant="caption" color="critical" style={styles.devText} numberOfLines={4}>
              {message}
            </Txt>
          </View>
        ) : null}

        <View style={styles.actions}>
          <Button label="Try again" variant="primary" onPress={onReset} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space[4],
  },
  card: {
    width: '100%',
    maxWidth: 400,
    borderRadius: radius.lg,
    padding: space[6],
    gap: space[3],
    borderWidth: 1,
  },
  center: {
    textAlign: 'center',
  },
  devBox: {
    borderRadius: radius.md,
    padding: space[3],
    borderWidth: 1,
  },
  devText: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 12,
  },
  actions: {
    marginTop: space[2],
  },
});

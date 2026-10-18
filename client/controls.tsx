import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";

export function Button({
  theme,
  title,
  label,
  onPress,
  disabled,
  secondary = false,
  danger = false,
}: {
  theme: PluginTheme;
  title: string;
  label?: string;
  onPress(): void;
  disabled?: boolean;
  secondary?: boolean;
  danger?: boolean;
}) {
  const c = theme.colors;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label ?? title}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        alignSelf: "flex-start",
        minHeight: 44,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 9,
        justifyContent: "center",
        borderWidth: secondary ? 1 : 0,
        borderColor: c.border,
        backgroundColor: secondary
          ? c.surface1
          : danger
            ? c.statusDanger
            : c.accent,
        opacity: disabled ? 0.45 : pressed ? 0.75 : 1,
      })}
    >
      <Text
        style={{
          fontSize: 14,
          fontWeight: "600",
          color: secondary
            ? danger
              ? c.statusDanger
              : c.foreground
            : c.accentForeground,
        }}
      >
        {title}
      </Text>
    </Pressable>
  );
}
export function Field({
  theme,
  label,
  value,
  onChange,
  placeholder,
  secure,
  multiline,
  hint,
  error,
  testID,
}: {
  theme: PluginTheme;
  label: string;
  value: string;
  onChange(value: string): void;
  placeholder?: string;
  secure?: boolean;
  multiline?: boolean;
  hint?: string;
  error?: string;
  testID?: string;
}) {
  const c = theme.colors;
  return (
    <View style={{ gap: 7 }}>
      <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "500" }}>
        {label}
      </Text>
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={c.foregroundMuted}
        secureTextEntry={secure}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        importantForAutofill="no"
        multiline={multiline}
        style={{
          borderWidth: 1,
          borderColor: error ? c.statusDanger : c.border,
          backgroundColor: c.surface0,
          color: c.foreground,
          fontSize: 14,
          paddingHorizontal: 12,
          paddingVertical: 11,
          borderRadius: 8,
          minHeight: multiline ? 112 : 44,
          ...(multiline ? { textAlignVertical: "top" as const } : {}),
        }}
      />
      {!!(error || hint) && (
        <Text
          style={{
            fontSize: 12,
            lineHeight: 18,
            color: error ? c.statusDanger : c.foregroundMuted,
          }}
        >
          {error || hint}
        </Text>
      )}
    </View>
  );
}
export function Notice({
  theme,
  children,
  error = false,
}: {
  theme: PluginTheme;
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <View
      accessibilityRole={error ? "alert" : undefined}
      style={{
        borderLeftWidth: 3,
        borderLeftColor: error
          ? theme.colors.statusDanger
          : theme.colors.accent,
        backgroundColor: theme.colors.surface1,
        borderRadius: 6,
        padding: 13,
      }}
    >
      <Text
        style={{
          color: error
            ? theme.colors.statusDanger
            : theme.colors.foregroundMuted,
          fontSize: 13,
          lineHeight: 20,
        }}
      >
        {children}
      </Text>
    </View>
  );
}
export function errorText(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : "The request could not be completed. Try again.";
  if (
    /\b\d{5,16}:[A-Za-z0-9_-]{20,}|Bearer\s|password\s*[:=]|token\s*[:=]/i.test(
      message,
    )
  )
    return "The request could not be completed. Check the connection and try again.";
  return message.replace(/\s+requestType=.*$/s, "").slice(0, 400);
}

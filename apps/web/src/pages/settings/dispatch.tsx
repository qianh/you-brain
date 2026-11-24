import { useCallback, useEffect, useState } from "react";

import type {
  DispatchDevicesResponse,
  DispatchPolicyPutBody,
  DispatchPolicyResponse,
} from "@you-brain/core/http/types.js";

import { BrowserDaemonError, type BrowserDaemon } from "../../api/client.js";
import { Banner } from "../../components/banner.js";
import { Button } from "../../components/button.js";
import { Card, CardHead, Section } from "../../components/card.js";
import { Toggle } from "../../components/toggle.js";
import { useToast } from "../../components/toast.js";
import { useDaemon } from "../../daemon-context.js";
import { commitPolicyPatch } from "./dispatch-model.js";
import { SettingRow } from "./setting-row.js";

function isUnsupportedError(error: unknown): boolean {
  if (error instanceof BrowserDaemonError) {
    return error.status === 404 || error.code === "NOT_SUPPORTED";
  }
  return false;
}

function isPolicyUnsupportedError(error: unknown): boolean {
  if (error instanceof BrowserDaemonError) {
    return error.status === 409;
  }
  return false;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  return fallback;
}

export interface DispatchSectionProps {
  client?: BrowserDaemon;
  initialDevices?: DispatchDevicesResponse | null;
  initialPolicy?: DispatchPolicyResponse | null;
  initialPolicyUnavailable?: string | null;
  initialPolicyError?: string | null;
}

/** 跨设备派活设置：仅保留本机接收派活开关与远程查看 T3/终端会话开关。 */
export function DispatchSection(props: DispatchSectionProps = {}) {
  const daemon = useDaemon();
  const client = props.client ?? daemon.client;
  const { t } = daemon;
  const { push } = useToast();

  const hasApi = typeof client.dispatchDevices === "function";

  const [unsupported, setUnsupported] = useState(!hasApi);
  const [devicesState, setDevicesState] = useState<DispatchDevicesResponse | null>(props.initialDevices ?? null);
  const [policyData, setPolicyData] = useState<DispatchPolicyResponse | null>(props.initialPolicy ?? null);
  const [policyUnavailable, setPolicyUnavailable] = useState<string | null>(props.initialPolicyUnavailable ?? null);
  const [policyError, setPolicyError] = useState<string | null>(props.initialPolicyError ?? null);
  const [savingPolicy, setSavingPolicy] = useState(false);

  const loadDevices = useCallback(async () => {
    if (typeof client.dispatchDevices !== "function") {
      setUnsupported(true);
      return;
    }
    try {
      const next = await client.dispatchDevices();
      setDevicesState(next);
      setUnsupported(false);
    } catch (error) {
      if (isUnsupportedError(error)) {
        setUnsupported(true);
      }
    }
  }, [client]);

  const loadPolicy = useCallback(async () => {
    if (typeof client.dispatchPolicy !== "function") return;
    try {
      const next = await client.dispatchPolicy();
      setPolicyData(next);
      setPolicyUnavailable(null);
      setPolicyError(null);
    } catch (error) {
      if (isUnsupportedError(error)) return;
      if (isPolicyUnsupportedError(error)) {
        setPolicyData(null);
        setPolicyError(null);
        setPolicyUnavailable(errorMessage(error, t("dispatchLoadError")));
        return;
      }
      setPolicyError(errorMessage(error, t("dispatchLoadError")));
    }
  }, [client, t]);

  const hasInitialSnapshot =
    props.initialDevices !== undefined ||
    props.initialPolicy !== undefined ||
    props.initialPolicyUnavailable !== undefined ||
    props.initialPolicyError !== undefined;

  useEffect(() => {
    if (!hasApi) {
      setUnsupported(true);
      return;
    }
    if (hasInitialSnapshot) return;
    void Promise.all([loadDevices(), loadPolicy()]);
  }, [hasApi, hasInitialSnapshot, loadDevices, loadPolicy]);

  const savePolicy = useCallback(
    async (patch: DispatchPolicyPutBody) => {
      if (!policyData || typeof client.updateDispatchPolicy !== "function") return;
      const updatePolicy = client.updateDispatchPolicy.bind(client);
      setSavingPolicy(true);
      try {
        await commitPolicyPatch({
          current: policyData,
          patch,
          save: updatePolicy,
          onOptimistic: (next) => setPolicyData(next),
          onCommit: (saved) => {
            setPolicyData(saved);
            setPolicyError(null);
          },
          onRollback: (previous, message) => {
            setPolicyData(previous);
            push({ message, tone: "danger" });
          },
          fallbackError: t("dispatchPolicySaveFailed"),
        });
      } finally {
        setSavingPolicy(false);
      }
    },
    [client, policyData, push, t],
  );

  if (!hasApi || unsupported) return null;

  const policy = policyData?.policy ?? null;

  return (
    <Section title={t("dispatchTitle")}>
      <Card>
        <CardHead title={t("dispatchPolicyTitle")} />
        {devicesState !== null && !devicesState.enrolled ? (
          <div className="notion-form">
            <Banner tone="warn">{t("dispatchNotEnrolledHint")}</Banner>
          </div>
        ) : null}
        {devicesState !== null && devicesState.enrolled && !devicesState.connected ? (
          <div className="notion-form">
            <Banner tone="info">{t("dispatchDisconnectedHint")}</Banner>
          </div>
        ) : null}
        {policyUnavailable ? (
          <div className="notion-form">
            <Banner tone="info">{policyUnavailable}</Banner>
          </div>
        ) : null}
        {policyError ? (
          <div className="notion-form">
            <Banner
              tone="danger"
              action={
                <Button size="sm" variant="ghost" onClick={() => void loadPolicy()}>
                  {t("retry")}
                </Button>
              }
            >
              {policyError}
            </Banner>
          </div>
        ) : null}
        {policyData && policy ? (
          <>
            <SettingRow
              title={t("dispatchPolicyEnabled")}
              hint={t("dispatchPolicyEnabledHint")}
              control="toggle"
            >
              <Toggle
                checked={policy.enabled}
                label={t("dispatchPolicyEnabled")}
                disabled={savingPolicy}
                onChange={(checked) => void savePolicy({ enabled: checked })}
              />
            </SettingRow>
            <SettingRow
              title={t("dispatchPolicyViewT3")}
              hint={t("dispatchPolicyViewT3Hint")}
              control="toggle"
            >
              <Toggle
                checked={policy.viewT3}
                label={t("dispatchPolicyViewT3")}
                disabled={savingPolicy}
                onChange={(checked) => void savePolicy({ viewT3: checked })}
              />
            </SettingRow>
          </>
        ) : null}
      </Card>
    </Section>
  );
}

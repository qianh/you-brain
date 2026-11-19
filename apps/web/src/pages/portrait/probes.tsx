import { useEffect, useState } from "react";
import type { PortraitProbeView } from "@you-brain/core/http/types.js";

import { BrowserDaemonError } from "../../api/client.js";
import { Button } from "../../components/button.js";
import { Chip } from "../../components/chip.js";
import { useToast } from "../../components/toast.js";
import { useDaemon } from "../../daemon-context.js";

export function PortraitProbes() {
  const { t, client, reload } = useDaemon();
  const { push } = useToast();
  const [rows, setRows] = useState<PortraitProbeView[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setListError(null);
    void client
      .portraitProbes()
      .then((body) => {
        if (!alive) return;
        setRows(body.probes);
      })
      .catch((caught: unknown) => {
        if (!alive) return;
        setRows([]);
        setListError(caught instanceof BrowserDaemonError ? caught.message : t("loadFailed"));
      });
    return () => {
      alive = false;
    };
  }, [client, t]);

  async function act(probe: PortraitProbeView, action: "keep" | "drop"): Promise<void> {
    if (busyId !== null) return;
    setBusyId(probe.id);
    try {
      const result = await client.reviewPortraitProbe({ id: probe.id, action });
      setRows(result.probes);
      push({
        message: t(action === "keep" ? "probeKept" : "probeDropped"),
        tone: action === "keep" ? "success" : "info",
      });
      void reload("status");
    } catch (caught: unknown) {
      const message =
        caught instanceof BrowserDaemonError && caught.message !== "" ? caught.message : t("actionFailed");
      push({ message, tone: "danger" });
    } finally {
      setBusyId(null);
    }
  }

  if (rows.length === 0 && listError === null) return null;

  return (
    <section className="portrait-block portrait-corrections" aria-label={t("probeTitle")}>
      <div className="portrait-kicker-row">
        <p className="portrait-kicker">{t("probeTitle")}</p>
        <Chip tone={rows.length > 0 ? "warn" : "neutral"}>{rows.length}</Chip>
      </div>
      <p className="portrait-note">{t("probeHint")}</p>
      {listError ? <p className="portrait-note">{listError}</p> : null}
      {rows.length > 0 ? (
        <ul className="portrait-correction-list">
          {rows.map((probe) => {
            const isBusy = busyId === probe.id;
            return (
              <li key={probe.id} className="portrait-correction">
                <div className="portrait-correction-head">
                  <span className="portrait-correction-section">
                    {probe.id}
                    {probe.day ? ` · ${probe.day}` : ""}
                  </span>
                  <Chip tone="neutral">
                    {t(probe.layer === "coding" ? "probeLayerCoding" : "probeLayerPersona")}
                  </Chip>
                </div>
                <p className="portrait-correction-text">{probe.situation}</p>
                <p className="portrait-note">
                  {t("probeExpect")}
                  {probe.expect}
                </p>
                <div className="portrait-correction-actions">
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    loading={isBusy}
                    disabled={busyId !== null}
                    onClick={() => {
                      void act(probe, "keep");
                    }}
                  >
                    {t("probeKeep")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busyId !== null}
                    onClick={() => {
                      void act(probe, "drop");
                    }}
                  >
                    {t("probeDrop")}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

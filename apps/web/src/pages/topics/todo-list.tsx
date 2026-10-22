import type { TodoStatus } from "@you-brain/protocol";
import type { TodoView } from "@you-brain/core/http/types.js";

import { Button } from "../../components/button.js";
import { Chip } from "../../components/chip.js";
import { Icon } from "../../components/icons.js";
import { Section } from "../../components/card.js";
import { Tooltip } from "../../components/tooltip.js";
import { useDaemon } from "../../daemon-context.js";
import { sortTodos } from "./logic.js";

export function TodoList({
  todos,
  busy,
  onSet,
}: {
  todos: readonly TodoView[];
  busy: boolean;
  onSet: (todoId: string, text: string, from: TodoStatus, to: TodoStatus) => void;
}) {
  const { t } = useDaemon();
  const sorted = sortTodos(todos);
  const openCount = sorted.filter((todo) => todo.status === "open").length;
  return (
    <Section title={t("todos")} {...(openCount > 0 ? { hint: t("openTodoCount", { count: openCount }) } : {})}>
      {sorted.length === 0 ? (
        <p className="topics-empty-line">{t("noTodos")}</p>
      ) : (
        <ul className="topics-todos">
          {sorted.map((todo) => {
            const who = todo.statusBy === "user" ? t("byUser") : t("byAuto");
            const pct = Math.max(0, Math.min(100, Math.round(todo.confidence * 100)));
            return (
              <li key={todo.todoId} className={`topics-todo is-${todo.status}`}>
                {todo.status === "open" ? (
                  <Tooltip content={t("completeTodo")}>
                    <button
                      type="button"
                      className="topics-check"
                      aria-label={t("completeTodo")}
                      disabled={busy}
                      onClick={() => onSet(todo.todoId, todo.text, todo.status, "done")}
                    />
                  </Tooltip>
                ) : (
                  <button type="button" className="topics-check is-set" disabled aria-hidden="true">
                    {todo.status === "done" ? <Icon name="check" size={12} /> : null}
                    {todo.status === "dropped" ? <Icon name="x" size={12} /> : null}
                  </button>
                )}
                <Tooltip content={t("todoMeta", { who, pct })}>
                  <span className="topics-todo-text" title={todo.text}>
                    {todo.text}
                  </span>
                </Tooltip>
                {todo.status === "open" ? (
                  <Button className="topics-drop" size="sm" variant="ghost" disabled={busy} onClick={() => onSet(todo.todoId, todo.text, todo.status, "dropped")}>
                    {t("dropTodo")}
                  </Button>
                ) : todo.status === "dropped" ? (
                  <Chip>{t("todoDropped")}</Chip>
                ) : (
                  <span />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

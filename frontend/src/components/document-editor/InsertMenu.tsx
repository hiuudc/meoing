import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Plus } from "lucide-react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
  useBasicTypeaheadTriggerMatch,
} from "@lexical/react/LexicalTypeaheadMenuPlugin";
import type { TextNode } from "lexical";
import {
  executeInsertCommand,
  INSERT_COMMANDS,
  type InsertCommand,
} from "./inserts";

interface InsertMenuButtonProps {
  language: string;
  onClose: () => void;
  onToggle: (trigger: HTMLButtonElement) => void;
  open: boolean;
}

class InsertMenuOption extends MenuOption {
  command: InsertCommand;

  constructor(command: InsertCommand) {
    super(command.id);
    this.command = command;
  }
}

function filterCommands(query: string | null): InsertCommand[] {
  const normalized = query?.trim().toLowerCase() ?? "";
  if (!normalized) return INSERT_COMMANDS;
  return INSERT_COMMANDS.filter((command) => (
    command.label.toLowerCase().includes(normalized)
    || command.description.toLowerCase().includes(normalized)
    || command.keywords.some((keyword) => keyword.includes(normalized))
  ));
}

function CommandList({
  commands,
  onSelect,
}: {
  commands: InsertCommand[];
  onSelect: (command: InsertCommand) => void;
}) {
  return (
    <div className="document-insert-menu-list" role="menu">
      {commands.map((command) => {
        const Icon = command.icon;
        return (
          <button
            key={command.id}
            type="button"
            role="menuitem"
            onClick={() => onSelect(command)}
          >
            <Icon size={17} />
            <span>
              <strong>{command.label}</strong>
              <small>{command.description}</small>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function InsertMenu({
  language,
  onClose,
  onToggle,
  open,
}: InsertMenuButtonProps) {
  const [editor] = useLexicalComposerContext();

  return (
    <div className="document-insert-menu">
      <button
        type="button"
        className={open ? "is-active document-toolbar-wide-button" : "document-toolbar-wide-button"}
        aria-expanded={open}
        aria-haspopup="menu"
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => onToggle(event.currentTarget)}
      >
        <Plus size={17} />
        <span>Insert</span>
      </button>
      {open ? (
        <div className="document-toolbar-popover document-insert-popover">
          <CommandList
            commands={INSERT_COMMANDS}
            onSelect={(command) => {
              executeInsertCommand(editor, command.id, language);
              onClose();
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

export function SlashMenuPlugin({ language }: { language: string }) {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState<string | null>(null);
  const triggerFn = useBasicTypeaheadTriggerMatch("/", {
    allowWhitespace: true,
    maxLength: 40,
    minLength: 0,
  });
  const options = useMemo(
    () => filterCommands(query).map((command) => new InsertMenuOption(command)),
    [query],
  );

  function selectOption(
    option: InsertMenuOption,
    textNodeContainingQuery: TextNode | null,
    closeMenu: () => void,
  ) {
    editor.update(() => {
      textNodeContainingQuery?.remove();
    });
    closeMenu();
    executeInsertCommand(editor, option.command.id, language);
  }

  return (
    <LexicalTypeaheadMenuPlugin
      onQueryChange={setQuery}
      onSelectOption={selectOption}
      options={options}
      triggerFn={triggerFn}
      menuRenderFn={(anchorElementRef, {
        options: visibleOptions,
        selectedIndex,
        selectOptionAndCleanUp,
        setHighlightedIndex,
      }) => {
        const anchor = anchorElementRef.current;
        if (!anchor) return null;
        return createPortal(
          <div className="document-slash-menu" role="menu">
            {visibleOptions.length ? visibleOptions.map((option, index) => {
              const Icon = option.command.icon;
              return (
                <button
                  className={selectedIndex === index ? "is-selected" : ""}
                  key={option.key}
                  ref={(element) => option.setRefElement(element)}
                  type="button"
                  role="menuitem"
                  aria-selected={selectedIndex === index}
                  onMouseEnter={() => setHighlightedIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectOptionAndCleanUp(option)}
                >
                  <Icon size={17} />
                  <span>
                    <strong>{option.command.label}</strong>
                    <small>{option.command.description}</small>
                  </span>
                </button>
              );
            }) : <p>No matching blocks</p>}
          </div>,
          anchor,
        );
      }}
    />
  );
}

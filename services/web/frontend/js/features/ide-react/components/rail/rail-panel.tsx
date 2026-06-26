import { Panel } from 'react-resizable-panels'
import { useRailContext } from '@/features/ide-react/context/rail-context'
import classNames from 'classnames'
import { useCallback, useLayoutEffect, useMemo } from 'react'
import usePreviousValue from '@/shared/hooks/use-previous-value'
import { HistorySidebar } from '@/features/ide-react/components/history-sidebar'
import { Tab } from 'react-bootstrap'
import { RailElement } from '@/features/ide-react/util/rail-types'
import { shouldIncludeElement } from '@/features/ide-react/util/rail-utils'

const DEFAULT_PANEL_SIZE = 15
const WORKBENCH_PANEL_SIZE = 20
const CODEX_PANEL_SIZE = 30
const CODEX_MIN_PANEL_SIZE = 24

export default function RailPanel({
  isReviewPanelOpen,
  isHistoryView,
  railTabs,
  focusMode,
}: {
  isReviewPanelOpen: boolean
  isHistoryView: boolean
  railTabs: RailElement[]
  focusMode: boolean
}) {
  const { selectedTab, panelRef, handlePaneExpand, handlePaneCollapse } =
    useRailContext()

  const prevTab = usePreviousValue(selectedTab)

  const tabHasChanged = useMemo(() => {
    return prevTab !== selectedTab
  }, [prevTab, selectedTab])

  const defaultSize =
    selectedTab === 'codex'
      ? CODEX_PANEL_SIZE
      : selectedTab === 'workbench'
        ? WORKBENCH_PANEL_SIZE
        : DEFAULT_PANEL_SIZE
  const minSize = selectedTab === 'codex' ? CODEX_MIN_PANEL_SIZE : 5

  const onCollapse = useCallback(() => {
    if (!tabHasChanged) {
      handlePaneCollapse()
    }
  }, [tabHasChanged, handlePaneCollapse])

  useLayoutEffect(() => {
    if (selectedTab !== 'codex') {
      return
    }

    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current
      if (!panel) {
        return
      }
      try {
        if (panel.getSize() < CODEX_MIN_PANEL_SIZE) {
          panel.resize(CODEX_PANEL_SIZE)
        }
      } catch {
        // The panel can be referenced before react-resizable-panels has
        // registered its dynamic tab id. minSize/defaultSize still enforce a
        // usable Codex layout once the panel is registered.
      }
    })

    return () => window.cancelAnimationFrame(frame)
  }, [panelRef, selectedTab])

  return (
    <Panel
      id={`ide-redesign-sidebar-panel-${isHistoryView ? 'file-tree' : selectedTab}`}
      className={classNames({ hidden: isReviewPanelOpen || focusMode })}
      order={1}
      defaultSize={defaultSize}
      minSize={minSize}
      maxSize={80}
      ref={panelRef}
      collapsible
      onCollapse={onCollapse}
      onExpand={handlePaneExpand}
    >
      {isHistoryView && <HistorySidebar />}
      <div
        className={classNames('ide-rail-content', {
          hidden: isHistoryView,
        })}
      >
        <Tab.Content className="ide-rail-tab-content">
          {railTabs
            .filter(shouldIncludeElement)
            .map(({ key, component, mountOnFirstLoad }) => (
              <Tab.Pane
                eventKey={key}
                key={key}
                mountOnEnter={!mountOnFirstLoad}
              >
                {component}
              </Tab.Pane>
            ))}
        </Tab.Content>
      </div>
    </Panel>
  )
}

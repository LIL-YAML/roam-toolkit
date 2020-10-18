import cytoscape, {NodeDataDefinition, NodeSingular} from 'cytoscape'
// @ts-ignore
import cola from 'cytoscape-cola'
import {assumeExists} from 'src/core/common/assert'
import {RoamPanel} from 'src/core/roam/panel/roam-panel'
import {PanelId} from 'src/core/roam/panel/roam-panel-utils'
import {minBy} from 'lodash'
import {injectStyle} from 'src/core/common/css'
import {delay} from 'src/core/common/async'
import {GraphModeSettings} from 'src/core/features/spatial-graph-mode/graph-mode-settings'

const GRAPH_MASK_ID = 'roam-toolkit-graph-mode--mask'
const GRAPH_MODE_CSS_ID = 'roam-toolkit-graph-mode'

const getDomViewport = (): HTMLElement => assumeExists(document.querySelector('.roam-body-main')) as HTMLElement

const MIN_EDGE_LENGTH = 50

cytoscape.use(cola)

export class GraphVisualization {
    static instance: GraphVisualization | null
    cy: cytoscape.Core

    constructor(container: HTMLElement) {
        const color = GraphModeSettings.get('Node Color')
        const selectionColor = GraphModeSettings.get('Selection Color')
        this.cy = cytoscape({
            container,
            style: [
                {
                    selector: 'node',
                    css: {
                        shape: 'roundrectangle',
                        'background-color': color,
                    },
                },
                {
                    selector: 'edge',
                    css: {
                        'line-color': color,
                        'target-arrow-color': color,
                        'source-arrow-color': color,
                        'curve-style': 'bezier',
                        'target-arrow-shape': 'triangle',
                    },
                },
                {
                    selector: ':selected',
                    css: {
                        'background-color': selectionColor,
                        'line-color': selectionColor,
                        'target-arrow-color': selectionColor,
                        'source-arrow-color': selectionColor,
                    },
                },
            ],
        })
        const domViewport = getDomViewport()
        // TODO move dom manipulation outside, leave this class purely concerned with Cytoscape
        this.cy.on('viewport resize render', () => {
            requestAnimationFrame(() => {
                domViewport.style.transform = `translate(${this.cy.pan().x}px, ${
                    this.cy.pan().y
                }px) scale(${this.cy.zoom()})`
            })
        })
        this.cy.on('render', () => {
            requestAnimationFrame(() => {
                // @ts-ignore .json() is just an object in the types
                const nodes = this.cy.json().elements.nodes
                if (nodes) {
                    nodes.forEach((node: NodeDataDefinition) => {
                        const panel = assumeExists(RoamPanel.get(assumeExists(node.data.id)))
                        const position = assumeExists(node.position)
                        panel.style.left = `${Math.round(position.x - panel.offsetWidth / 2)}px`
                        panel.style.top = `${Math.round(position.y - panel.offsetHeight / 2) + 5}px`
                    })
                }
            })
        })
        this.cy.maxZoom(1)
        this.cy.minZoom(0.2)
    }

    addNode(toPanel: PanelId, fromPanel: PanelId | null = null) {
        let node = this.cy.getElementById(toPanel)
        if (node.length === 0) {
            node = this.cy.add({
                data: {
                    id: toPanel,
                },
            })

            if (fromPanel) {
                const fromNode = this.cy.getElementById(fromPanel)
                node.position({
                    // Grow the graph towards the right
                    x: fromNode.position().x + fromNode.width() + MIN_EDGE_LENGTH,
                    // Tiny random offset prevents nodes from getting jammed if it spawns
                    // in the exact same location as another
                    y: fromNode.position().y + Math.random() * 10,
                })
            } else {
                node.position(this.cy.pan())
            }
        }

        if (
            // Don't add an edge if you're air-dropping into an orphan page (e.g. search)
            fromPanel &&
            // Don't attach edges back to self
            fromPanel !== toPanel &&
            // Don't attach redundant edges
            this.cy.$(`edge[source = "${fromPanel}"][target = "${toPanel}"]`).length === 0
        ) {
            this.cy.edges().unselect()
            this.cy
                .add({
                    data: {
                        source: fromPanel,
                        target: toPanel,
                    },
                })
                .select()
        }

        // bring attention to the newly selected node
        this.selectNode(node)
        this.cy.promiseOn('layoutstop').then(() => {
            this.panTo(toPanel, fromPanel)
        })
    }

    replaceNodeNames(before: string, after: string) {
        if (before === after) {
            return
        }
        // Replace the main node itself
        this.renameNode(this.cy.getElementById(before), after)
        // Replace usages in complex pages
        this.cy.nodes().forEach(node => {
            if (node.id().includes(`[[${before}]]`)) {
                this.renameNode(node, node.id().replace(`[[${before}]]`, `[[${after}]]`))
            }
        })
    }

    renameNode(node: NodeSingular, name: string) {
        // node ids are immutable. We have to create a new one
        const newNode = this.cy.add({
            data: {
                id: name,
            },
        })
        newNode.position(node.position())
        newNode.style('width', node.style('width'))
        newNode.style('height', node.style('height'))
        node.connectedEdges(`[source = "${node.id()}"]`).forEach(edge => {
            this.cy.add({
                data: {
                    source: name,
                    target: edge.target().id(),
                },
            })
        })
        node.connectedEdges(`[target = "${node.id()}"]`).forEach(edge => {
            this.cy.add({
                data: {
                    source: edge.source().id(),
                    target: name,
                },
            })
        })
        node.remove()
    }

    panTo(toPanel: PanelId, fromPanel: PanelId | null = null) {
        let nodesToFocus = this.cy.getElementById(toPanel)
        if (fromPanel) {
            nodesToFocus = nodesToFocus.union(this.cy.getElementById(fromPanel))
        }
        this.cy.stop(true, true) // stop the previous animation
        this.cy.animate({
            fit: {
                eles: nodesToFocus,
                padding: 50,
            },
            easing: 'ease-out',
            duration: 200,
            complete: () => {
                // avoid accidentally selecting text dues to panels shifting underneath
                // before getting a change to release the click
                window.getSelection()?.removeAllRanges()
            },
        })
    }

    removeNode(panel: PanelId) {
        this.cy.getElementById(panel).remove()
    }

    runLayout(firstRender: boolean = false) {
        this.cy.$('node').forEach(node => {
            const domNode = RoamPanel.get(node.id())
            if (domNode) {
                node.style('width', domNode.offsetWidth + 10)
                node.style('height', domNode.offsetHeight + 20)
            }
        })
        this.cy
            .layout({
                name: 'cola',
                fit: false,
                // @ts-ignore randomize when laying out for the first time, to avoid seizures from all the nodes being jammed on the same space
                randomize: firstRender,
                // @ts-ignore
                maxSimulationTime: firstRender ? 1000 : 200,
                nodeSpacing: () => MIN_EDGE_LENGTH,
            })
            .stop()
            .run()
    }

    resetPanelStyles() {
        // @ts-ignore .json() is just an object in the types
        const nodes = this.cy.json().elements.nodes
        if (nodes) {
            nodes.forEach((node: NodeDataDefinition) => {
                const panel = assumeExists(RoamPanel.get(assumeExists(node.data.id)))
                panel.style.removeProperty('left')
                panel.style.removeProperty('top')
            })
        }
    }

    zoomBy(scale: number) {
        this.cy.zoom({
            level: this.cy.zoom() * scale,
            renderedPosition: {
                x: this.cy.width() / 2,
                y: this.cy.height() / 2,
            },
        })
    }

    zoomOutCompletely() {
        this.cy.fit(undefined, 50)
    }

    panBy(x: number, y: number) {
        this.cy.panBy({x, y})
    }

    selectNode(node: NodeSingular) {
        this.cy.edges().unselect()
        this.cy.nodes().unselect()
        node.select().edges().select()
    }

    dragSelectionBy(x: number, y: number) {
        const zoom = this.cy.zoom()
        this.cy.nodes(':selected').shift({x: x / zoom, y: y / zoom})
        this.panBy(-x, -y)
    }

    nodeInMiddleOfViewport(): NodeSingular {
        const viewport = this.cy.extent()
        const viewportMiddle = {
            x: viewport.x1 + viewport.w / 2,
            y: viewport.y1 + viewport.h / 2,
        }
        return assumeExists(
            minBy(
                this.cy.nodes().map(node => node),
                node => {
                    return distance(viewportMiddle, node.position())
                }
            )
        )
    }

    selectMiddleOfViewport() {
        const middleNode = this.nodeInMiddleOfViewport()
        this.selectNode(middleNode)
    }

    ensureNodeIsSelected() {
        if (this.cy.nodes(':selected').length === 0) {
            this.selectMiddleOfViewport()
        }
    }

    onSelectNode(handleSelect: (nodeId: PanelId) => void) {
        this.cy.on('select', () => {
            const node = this.cy.nodes(':selected').first()
            if (node.length > 0) {
                handleSelect(node.id())
            }
        })
    }

    destroy() {
        this.cy.destroy()
    }

    static async init() {
        if (!GraphVisualization.instance) {
            const graphElement = document.createElement('div')
            graphElement.id = GRAPH_MASK_ID
            document.body.prepend(graphElement)

            injectStyle(
                `
                #${GRAPH_MASK_ID} {
                    position: fixed;
                    left: 0;
                    right: 0;
                    top: 0;
                    bottom: 0;
                }
                :root {
                    --card-width: 550px;
                }

                /* REMOVE UI CRUFT */
                #right-sidebar {
                    background-color: transparent;
                }
                #right-sidebar > div:first-child, /* sidebar toggle */
                #buffer, /* help icon in the bottom right */
                .roam-toolkit--panel-dupe /* extra sidebar panels that match the main panel */ {
                    display: none !important;
                }
                /* remove horizontal dividers between sidebar pages */
                .sidebar-content > div > div {
                    border: none !important;
                }

                /* Make the whole app click-through-able, so we can pan/zoom Cytoscape */
                #app {
                    pointer-events: none;
                }
                /* But make the actual content itself clickable */
                .roam-sidebar-container, .roam-topbar, .roam-toolkit--panel {
                    pointer-events: auto;
                }

                /* The container that holds everything */
                .roam-main .roam-body-main {
                    /* match Cytoscape's zoom origin */
                    transform-origin: 0 0;
                    position: fixed !important;
                    top: 0 !important;
                    left: 0 !important;
                    right: 0 !important;
                    bottom: 0 !important;
                    padding: 0 !important;
                    margin: 0 !important;
                }
                .roam-center {
                    /* cancel position: static on the main panel */
                    position: initial;
                }
                .roam-center .roam-toolkit--panel {
                    /* cancel out margins that custom themes might add */
                    margin: 0 !important;
                }
                .roam-toolkit--panel {
                    /* min-width doesn't really work, it jams up against #roam-right-sidebar-content */
                    width: ${GraphModeSettings.get('Width')};
                    height: auto !important; /* prevent the main panel from stretching 100% */
                    min-height: ${GraphModeSettings.get('Min Height')};
                    max-height: ${GraphModeSettings.get('Max Height')};
                    border-radius: 5px;
                    position: absolute !important;
                    background: white;
                    overflow-y: scroll !important;
                    margin: 0 !important;
                }
                /* The innermost sidebar div plays best with custom themes */
                .sidebar-content .roam-toolkit--panel {
                    padding: 0 16px !important;
                }
                /* The innermost main div plays best with custom themes */
                .roam-center > div {
                    overflow: visible !important;
                }
                /* Indicate when a main panel's edges are anchored by a hidden sidebar*/
                .roam-toolkit--panel-anchored::before {
                    content: "⚓";
                    left: 6px;
                    top: 6px;
                    position: absolute;
                }
                `,
                GRAPH_MODE_CSS_ID
            )

            GraphVisualization.instance = new GraphVisualization(graphElement)
            // Wait for styles to finish applying, so panels have the right dimensions,
            // and cytoscape has fully instantiated
            await delay(300)
        }
    }

    static get(): GraphVisualization {
        return assumeExists(GraphVisualization.instance)
    }

    static destroy() {
        if (GraphVisualization.instance) {
            GraphVisualization.instance.resetPanelStyles()
            GraphVisualization.instance.destroy()
            const domViewport = getDomViewport()
            domViewport.style.width = '100vw'
            domViewport.style.height = 'calc(100% - 45px)'
            domViewport.style.removeProperty('transform')

            document.getElementById(GRAPH_MODE_CSS_ID)?.remove()
            document.getElementById(GRAPH_MASK_ID)?.remove()

            GraphVisualization.instance = null
        }
    }
}

type Vector = {x: number; y: number}

const distance = (v1: Vector, v2: Vector) => Math.sqrt((v1.x - v2.x) ** 2 + (v1.y - v2.y) ** 2)

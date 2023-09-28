import { Component, OnInit, OnDestroy, ViewChildren, QueryList } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { catchError, startWith } from 'rxjs/operators';
import { Subject, Subscription, of } from 'rxjs';
import { StateService } from '../../services/state.service';
import { WebsocketService } from '../../services/websocket.service';
import { RelativeUrlPipe } from '../../shared/pipes/relative-url/relative-url.pipe';
import { BlockExtended, TransactionStripped } from '../../interfaces/node-api.interface';
import { ApiService } from '../../services/api.service';
import { BlockOverviewGraphComponent } from '../block-overview-graph/block-overview-graph.component';
import { detectWebGL } from '../../shared/graphs.utils';
import { animate, style, transition, trigger } from '@angular/animations';
import { BytesPipe } from '../../shared/pipes/bytes-pipe/bytes.pipe';

function bestFitResolution(min, max, n): number {
  const target = (min + max) / 2;
  let bestScore = Infinity;
  let best = null;
  for (let i = min; i <= max; i++) {
    const remainder = (n % i);
    if (remainder < bestScore || (remainder === bestScore && (Math.abs(i - target) < Math.abs(best - target)))) {
      bestScore = remainder;
      best = i;
    }
  }
  return best;
}

@Component({
  selector: 'app-eight-blocks',
  templateUrl: './eight-blocks.component.html',
  styleUrls: ['./eight-blocks.component.scss'],
  animations: [
    trigger('infoChange', [
      transition(':enter', [
        style({ opacity: 0 }),
        animate('1000ms', style({ opacity: 1 })),
      ]),
      transition(':leave', [
        animate('1000ms 500ms', style({ opacity: 0 }))
      ])
    ]),
  ],
})
export class EightBlocksComponent implements OnInit, OnDestroy {
  network = '';
  latestBlocks: BlockExtended[] = [];
  isLoadingTransactions = true;
  strippedTransactions: { [height: number]: TransactionStripped[] } = {};
  webGlEnabled = true;
  hoverTx: string | null = null;

  blocksSubscription: Subscription;
  cacheBlocksSubscription: Subscription;
  networkChangedSubscription: Subscription;
  queryParamsSubscription: Subscription;
  graphChangeSubscription: Subscription;

  autofit: boolean = false;
  padding: number = 0;
  wrapBlocks: boolean = false;
  blockWidth: number = 1080;
  animationDuration: number = 2000;
  animationOffset: number = 0;
  stagger: number = 0;
  testing: boolean = true;
  testHeight: number = 800000;
  testShiftTimeout: number;

  showInfo: boolean = true;
  blockInfo: { [key: string]: string}[] = [];

  wrapperStyle = {
    '--block-width': '1080px',
    width: '1080px',
    maxWidth: '1080px',
    padding: '',
  };
  containerStyle = {};
  resolution: number = 86;

  @ViewChildren('blockGraph') blockGraphs: QueryList<BlockOverviewGraphComponent>;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    public stateService: StateService,
    private websocketService: WebsocketService,
    private apiService: ApiService,
    private bytesPipe: BytesPipe,
  ) {
    this.webGlEnabled = detectWebGL();
  }

  ngOnInit(): void {
    this.websocketService.want(['blocks']);
    this.network = this.stateService.network;

    this.blocksSubscription = this.stateService.blocks$
      .subscribe((blocks) => {
        this.handleNewBlock(blocks);
      });

    this.queryParamsSubscription = this.route.queryParams.subscribe((params) => {
      this.autofit = params.autofit === 'true';
      this.padding = Number.isInteger(Number(params.padding)) ? Number(params.padding) : 0;
      this.blockWidth = Number.isInteger(Number(params.blockWidth)) ? Number(params.blockWidth) : 1080;
      this.wrapBlocks = params.wrap === 'true';
      this.stagger = Number.isInteger(Number(params.stagger)) ? Number(params.stagger) : 0;
      this.animationDuration = Number.isInteger(Number(params.animationDuration)) ? Number(params.animationDuration) : 2000;
      this.animationOffset = this.padding * 2;

      if (this.autofit) {
        this.resolution = bestFitResolution(76, 96, this.blockWidth - this.padding * 2);
      } else {
        this.resolution = 86;
      }

      this.wrapperStyle = {
        '--block-width': this.blockWidth + 'px',
        width: this.blockWidth + 'px',
        maxWidth: this.blockWidth + 'px',
        padding: (this.padding || 0) +'px 0px',
      };

      if (params.test === 'true') {
        this.blocksSubscription.unsubscribe();
        this.blocksSubscription = (new Subject<BlockExtended[]>()).subscribe((blocks) => {
          this.handleNewBlock(blocks);
        });
        this.shiftTestBlocks();
      }
    });

    this.setupBlockGraphs();

    this.networkChangedSubscription = this.stateService.networkChanged$
      .subscribe((network) => this.network = network);
  }

  ngAfterViewInit(): void {
    this.graphChangeSubscription = this.blockGraphs.changes.pipe(startWith(null)).subscribe(() => {
      this.setupBlockGraphs();
    });
  }

  ngOnDestroy(): void {
    this.stateService.markBlock$.next({});
    this.blocksSubscription?.unsubscribe();
    this.cacheBlocksSubscription?.unsubscribe();
    this.networkChangedSubscription?.unsubscribe();
    this.queryParamsSubscription?.unsubscribe();
  }

  shiftTestBlocks(): void {
    const sub = this.apiService.getBlocks$(this.testHeight).subscribe(result => {
      sub.unsubscribe();
      this.handleNewBlock(result);
      this.testHeight++;
      clearTimeout(this.testShiftTimeout);
      this.testShiftTimeout = window.setTimeout(() => { this.shiftTestBlocks(); }, 10000);
    });
  }

  async handleNewBlock(blocks: BlockExtended[]): Promise<void> {
    const readyPromises: Promise<TransactionStripped[]>[] = [];
    const previousBlocks = this.latestBlocks;
    const newHeights = {};
    this.latestBlocks = blocks;
    for (const block of blocks) {
      newHeights[block.height] = true;
      if (!this.strippedTransactions[block.height]) {
        readyPromises.push(new Promise((resolve) => {
          const subscription = this.apiService.getStrippedBlockTransactions$(block.id).pipe(
            catchError(() => {
              return of([]);
            }),
          ).subscribe((transactions) => {
            this.strippedTransactions[block.height] = transactions;
            subscription.unsubscribe();
            resolve(transactions);
          });
        }));
      }
    }
    await Promise.allSettled(readyPromises);
    this.updateBlockGraphs(blocks);

    // free up old transactions
    previousBlocks.forEach(block => {
      if (!newHeights[block.height]) {
        delete this.strippedTransactions[block.height];
      }
    });
  }

  updateBlockGraphs(blocks): void {
    const startTime = performance.now() + 1000 - (this.stagger < 0 ? this.stagger * 8 : 0);
    if (this.blockGraphs) {
      this.blockGraphs.forEach((graph, index) => {
        graph.replace(this.strippedTransactions[blocks?.[index]?.height] || [], 'right', false, startTime + (this.stagger * index));
      });
    }
    this.showInfo = false;
    setTimeout(() => {
      this.blockInfo = blocks.map(block => {
        return {
          height: `${block.height}`,
          hash: block.id,
          time: (new Date(block.timestamp * 1000)).toLocaleTimeString(),
          count: `${block.tx_count} txs`,
          size: `${this.bytesPipe.transform(block.size, 2, 'B', 'MB', true)}`,
        };
      });
      this.showInfo = true;
    }, 1600);  // Should match the animation time.
  }

  setupBlockGraphs(): void {
    if (this.blockGraphs) {
      this.blockGraphs.forEach((graph, index) => {
        graph.destroy();
        graph.setup(this.strippedTransactions[this.latestBlocks?.[index]?.height] || []);
      });
    }
  }

  onTxClick(event: { tx: TransactionStripped, keyModifier: boolean }): void {
    const url = new RelativeUrlPipe(this.stateService).transform(`/tx/${event.tx.txid}`);
    if (!event.keyModifier) {
      this.router.navigate([url]);
    } else {
      window.open(url, '_blank');
    }
  }

  onTxHover(txid: string): void {
    if (txid && txid.length) {
      this.hoverTx = txid;
    } else {
      this.hoverTx = null;
    }
  }
}
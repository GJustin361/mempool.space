import { ChangeDetectionStrategy, Component, Input, OnInit } from '@angular/core';
import { combineLatest, Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { StateService } from '../../services/state.service';

interface EpochProgress {
  base: string;
  change: number;
  progress: number;
  remainingBlocks: number;
  newDifficultyHeight: number;
  colorAdjustments: string;
  colorPreviousAdjustments: string;
  estimatedRetargetDate: number;
  previousRetarget: number;
  blocksUntilHalving: number;
  timeUntilHalving: number;
  timeAvg: number;
  adjustedTimeAvg: number;
}

@Component({
  selector: 'app-difficulty-mining',
  templateUrl: './difficulty-mining.component.html',
  styleUrls: ['./difficulty-mining.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DifficultyMiningComponent implements OnInit {
  isLoadingWebSocket$: Observable<boolean>;
  difficultyEpoch$: Observable<EpochProgress>;
  blocksUntilHalving: number | null = null;
  timeUntilHalving = 0;
  now = new Date().getTime();

  @Input() showProgress = true;
  @Input() showHalving = false;
  @Input() showTitle = true;

  constructor(
    public stateService: StateService,
  ) { }

  ngOnInit(): void {
    this.isLoadingWebSocket$ = this.stateService.isLoadingWebSocket$;
    this.difficultyEpoch$ = combineLatest([
      this.stateService.blocks$,
      this.stateService.difficultyAdjustment$,
    ])
    .pipe(
      map(([blocks, da]) => {
        const maxHeight = blocks.reduce((max, block) => Math.max(max, block.height), 0);
        let colorAdjustments = '#ffffff66';
        if (da.difficultyChange > 0) {
          colorAdjustments = '#3bcc49';
        }
        if (da.difficultyChange < 0) {
          colorAdjustments = '#dc3545';
        }

        let colorPreviousAdjustments = '#dc3545';
        if (da.previousRetarget) {
          if (da.previousRetarget >= 0) {
            colorPreviousAdjustments = '#3bcc49';
          }
          if (da.previousRetarget === 0) {
            colorPreviousAdjustments = '#ffffff66';
          }
        } else {
          colorPreviousAdjustments = '#ffffff66';
        }

        this.blocksUntilHalving = 210000 - (maxHeight % 210000);
        this.timeUntilHalving = new Date().getTime() + (this.blocksUntilHalving * 600000);
        this.now = new Date().getTime();

        const data = {
          base: `${da.progressPercent.toFixed(2)}%`,
          change: da.difficultyChange,
          progress: da.progressPercent,
          remainingBlocks: da.remainingBlocks - 1,
          colorAdjustments,
          colorPreviousAdjustments,
          newDifficultyHeight: da.nextRetargetHeight,
          estimatedRetargetDate: da.estimatedRetargetDate,
          previousRetarget: da.previousRetarget,
          blocksUntilHalving: this.blocksUntilHalving,
          timeUntilHalving: this.timeUntilHalving,
          timeAvg: da.timeAvg,
          adjustedTimeAvg: da.adjustedTimeAvg,
        };
        return data;
      })
    );
  }

  isEllipsisActive(e): boolean {
    return (e.offsetWidth < e.scrollWidth);
  }
}

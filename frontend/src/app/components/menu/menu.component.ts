import { Component, OnInit, Output, EventEmitter, HostListener } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { MenuGroup } from '../../interfaces/services.interface';
import { StorageService } from '../../services/storage.service';
import { Router } from '@angular/router';
import { StateService } from '../../services/state.service';

@Component({
  selector: 'app-menu',
  templateUrl: './menu.component.html',
  styleUrls: ['./menu.component.scss']
})

export class MenuComponent implements OnInit {
  @Output() loggedOut = new EventEmitter<boolean>();

  navOpen: boolean = false;
  userMenuGroups$: Observable<MenuGroup[]> | undefined;
  userAuth: any | undefined;
  isServicesPage = false;

  constructor(
    private apiService: ApiService,
    private storageService: StorageService,
    private router: Router,
    private stateService: StateService
  ) {}

  ngOnInit(): void {
    this.userAuth = this.storageService.getAuth();
    if (this.stateService.env.GIT_COMMIT_HASH_MEMPOOL_SPACE) {
      this.userMenuGroups$ = this.apiService.getUserMenuGroups$();
    }

    this.isServicesPage = this.router.url.includes('/services/');
    this.navOpen = this.isServicesPage && !this.isSmallScreen();
  }

  isSmallScreen() {
    return window.innerWidth <= 767.98;
  }

  logout(): void {
    this.apiService.logout$().subscribe();
    this.loggedOut.emit(true);
  }

  onLinkClick() {
    if (!this.isServicesPage || this.isSmallScreen()) {
      this.navOpen = false;
    }
  }

  hambugerClick() {
    this.navOpen = !this.navOpen;
  }

  @HostListener('window:resize', ['$event'])
  onResize(event) {
    if (this.isServicesPage) {
      this.navOpen = !this.isSmallScreen();
    }
  }
}
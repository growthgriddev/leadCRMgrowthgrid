// Firebase init — ye keys public hain (client-side). Asli security Firestore Rules karti hain.
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFunctions } from 'firebase/functions';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: 'AIzaSyCQiua5m4rvIRHkUQjgDULR_bXvMeqKx-M',
  authDomain: 'growthgrid-saas.firebaseapp.com',
  projectId: 'growthgrid-saas',
  storageBucket: 'growthgrid-saas.firebasestorage.app',
  messagingSenderId: '364689646896',
  appId: '1:364689646896:web:20e1b3b5152fde343654f5',
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const functions = getFunctions(app, 'asia-south1');

// Offline cache on — reads dobara nahi lagti (free-tier bachat + mobile pe fast)
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
